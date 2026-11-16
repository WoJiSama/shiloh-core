import type { CommitmentRunOptions, CommitmentRunResult } from '../../../contracts/commitments.js'
import type { ChatRequestData, ChatResponse } from '../../../contracts/modelGateway.js'
import type { ExecutionOptions } from '../../../contracts/modelExecution.js'
import type { AgentHistoryRecall, AgentHistoryRequestSource } from '../../../contracts/agentHistory.js'
import type { AgentFileBytes, AgentFileListing, AgentFileRequest, ConversationFileCatalog, ConversationFileEntry, ConversationFileReadOptions, FileReadGuard, MessageFileReadOptions } from '../../../contracts/agentFiles.js'
import type { AgentFileUpload, FileDeliveryReceipt } from '../../../contracts/agentFileDelivery.js'
import type { SendMediaAction } from '../../../contracts/agentMedia.js'
import type { AgentMusicCard } from '../../../contracts/agentMusic.js'
import type { AgentMediaArtifact, AgentMediaRelayPlan } from '../../../contracts/agentMediaRelay.js'
import { validateAgentMediaRelayPlan } from '../../media/domain/agentMediaRelayPlan.js'
import { validateAgentMusicCard } from '../../media/infrastructure/agentMusicCard.js'
import type { PersonaGuardConfig } from '../../../contracts/persona.js'
import { validateAgentMedia } from '../../media/infrastructure/agentMediaBytes.js'
import { agentFileUploadText, normalizeFileDeliveryReceipt, validateAgentFileUpload } from '../../messaging/infrastructure/agentFileDelivery.js'
import type { PersonaText } from '../../conversation/domain/personaSource.js'
import { randomUUID, createHash } from 'node:crypto'
import type { CharacterScope, CharacterReceipt, CharacterDecision, CharacterState } from '../../../contracts/character.js'
import { createPersonaSnapshot } from '../../conversation/infrastructure/personaSnapshot.js'
import { createCharacterStore } from './characterStore.js'
import { createCharacterTools } from './characterTools.js'
import { createCharacterTurnTool, type CharacterTurnFinishResult } from './characterTurn.js'
import { createCharacterConsistencyReviewer } from './characterConsistency.js'
import { formatSimulationDelivery, planMessageDelivery } from '../domain/messageDelivery.js'
import type { CharacterActivityOperation, CharacterFeedItem } from '../../../contracts/characterActivities.js'
import { createCharacterWorkspace, createCharacterWorkspaceTools } from './characterWorkspace.js'
import { createCharacterSubscriptions, createCharacterSubscriptionTools } from './characterSubscriptions.js'
import { createCharacterReflection } from './characterReflection.js'
import { createCharacterSharedSelf, createSharedSelfTools } from './characterSharedSelf.js'
import { createCharacterWorkerTools, formatSavedCharacterWorkResult, type CharacterWorkerTask, type CharacterWorkerResult } from './characterWorker.js'
import { activeCharacterMemories, characterMemoryVisibility, beginCharacterGoalAttempt, beginCharacterGoalAction, recordCharacterReceipt, dueCharacterGoal, expireCharacterGoals, formatCharacterSection, classifyCharacterResult, setCharacterPaused, transitionCharacterGoal, deleteCharacterMemory } from '../domain/characterState.js'
import { recoverInterruptedCharacter } from '../domain/characterTransfer.js'
import { resolveSimulationActor, AUTONOMOUS_EXTRA_TOOLS, AUTONOMOUS_DENIED_SIM_TOOLS, AUTONOMOUS_CREATIVE_TOOLS, type SimulationActor } from '../domain/executionActor.js'
import type { SimAffinityEntry, SimAffinityMap, SimulationSection, SimHistoryMessage, SimMemoryEntry, SimMessage, SimMoodState, SimRuntimeConfig, SimSessionState, SimToolResultObservation, SimWakeReason } from '../../../contracts/simulation.js'
import type { PersonMemorySource } from '../../../contracts/personMemory.js'
import type { PersonProfileExtractor, PersonProfileExtractionContext } from '../../../contracts/personProfileExtraction.js'
import type { AgentBindingSnapshot, AgentBindingTurn, AgentConversationScope, ConversationAddress, PlatformAccountRef } from '../../../contracts/agentBinding.js'
import type { ForwardContent, ForwardReference, MessageImage, MessageImageReadOptions, PlatformNudgeEvent } from '../../../contracts/platformConnection.js'
import type { IncomingMessage, MessageActionOptions, MessageActionPort, MessagePart, OutgoingPart, MessageBundleItem, MessageBundlePart } from '../../../contracts/platformMessage.js'
import type { DeliveryReceipt } from '../../../contracts/delivery.js'
import type { AgentToolMessage, AgentToolRequest } from '../../../contracts/agentTool.js'
import type { ConversationMembersSnapshot } from '../../../contracts/platformConnection.js'
import type { PersonaScope } from '../../../contracts/persona.js'
import { agentBindingToken, agentPersonaScopeId, conversationAddressKey } from '../../runtime/domain/agentBindings.js'
import { createDefaultSimSession, isSimulationUserId } from '../domain/simConfig.js'
import { affinityLevel, buildMemeExtractionPrompt, bumpMemeUsage, defaultAffinityEntry, dueMemories, formatSelfMemorySection, mergeMemeCandidates, normalizeMemoryList, parseMemeCandidates } from '../domain/simMemory.js'
import { mineUserCatchphrases } from '../domain/userStyle.js'
import { boundedTimerDelay, safeSetTimeout, isDuplicateMessageId, sanitizeUntrustedText, safeToolErrorText, shouldSendErrorNotice } from '../domain/safety.js'
import { evaluateWakeTrigger, formatWakeReason, mergeWakeReason, messageReasonStillPending, pushPendingReason, TIMER_WAKE_REASONS } from '../domain/wakeTrigger.js'
import { resolveSimToolSurface } from '../domain/toolPolicy.js'
import { acknowledgeMessages, noteModelSeen, readThroughSeq } from '../domain/watermark.js'
import { buildWakeSnapshot, compactSimMessage } from '../domain/messageView.js'
import { buildSocialPermissionRequest, readSocialVerdict, type SocialAction } from '../domain/socialPermission.js'
import { computeWaitOutcome, normalizeWaitPlan, type SimWaitPlan } from '../domain/waitGate.js'
import { checkSendAllowance, checkWakeBudget, describeBudgetLimit, isDirectAddressKind, limitNoticeDue, shouldAnnounceBudgetLimit, invalidatePreSleepWaitByParticipation, markPreSleepSatisfied, recordSend, recordWake, recordWakeTokens, resetPreSleepWait, rollBudgetDay } from '../domain/budget.js'
import { buildCharacterTurnContext, buildSimSystemPrompt, buildWakePrompt, trimAgentHistory } from '../domain/promptBuilder.js'
import { isSilentDeclaration, isWrappedAnnotation, mentionsSilenceVocabulary } from '../domain/silentDeclaration.js'
import { parsePersonProfilePatches, groundPersonProfileCandidate, interestMatchesTitle, type PersonProfile } from '../domain/personProfile.js'
import { isSleeping, activityFactor, sleepinessNote, staleMessageNote, type RhythmWindow } from '../domain/rhythm.js'
import { normalizeLifeThreads, mergeThreadSync, formatLifeThreads, type LifeThread } from '../domain/lifeThread.js'
import { applyMoodUpdate, formatMoodSection, moodSummaryLine, normalizeSimMood, projectMood, type MoodAxis } from '../domain/mood.js'
import { checkHealth, formatAlerts, type HealthAlert } from '../domain/healthSentinel.js'
import { buildChatRequestData } from '../../models/domain/modelGateway.js'
import { safeTruncateUnicode } from '../../models/domain/unicodeText.js'
import { createSimSessionStore, simulationSessionKey, type SimGroupOverrides, type SimSessionStore } from './simSessionStore.js'
import { createInitialPromptStore } from './simInitialPrompt.js'
import { resolveSimulationGroupConfig, seedSimulationOverrides, simulationGroupOverride } from './simulationGroupPolicy.js'
import { decodeSimulationAddressKey, isQqSimulationAddress, qqSimulationAddress, simulationAddressKey } from './simulationAddress.js'
import { createPersonMemoryStore } from '../../memory/infrastructure/personMemoryStore.js'
import { canReadUnattributedMemory, formatPersonMemoryFacts, personMemoryAddress, revokePersonMemorySourceForAccount } from '../../memory/infrastructure/personMemoryContext.js'
import type { AgentSemanticMemoryRecall } from '../../../contracts/semanticMemory.js'
import { isPersonMemoryRedacted } from '../../memory/domain/personMemory.js'
import type { AbstractTool } from '../../toolSupport/infrastructure/AbstractTool.js'
import { redactInternalStatusLeaks } from '../../conversation/domain/internalStatusLeak.js'
import { sanitizeFinalReplyText, looksLikeToolArguments } from '../../conversation/domain/replySanitizer.js'
import { normalizeDelegatedEntries, formatDelegatedSection } from '../../memory/domain/delegatedMemory.js'
import { createSimTools, simToolsAsFunctions, type SimSendResult, type SimWaitResult, type SimToolContext } from './simTools.js'
import { normalizeDeliveryReceipt } from '../../messaging/domain/deliveryReceipt.js'
import { validateAgentToolImage } from '../../image/infrastructure/agentToolImage.js'
import { validateMessageBundle } from '../../messaging/infrastructure/messageBundle.js'
import { validateAgentToolMessage } from '../../messaging/infrastructure/agentToolMessage.js'
import { createSimulationAgentFiles, simulationFileMetadata, type SimulationFileProjection, type SimulationMessageFileSource } from './simulationAgentFiles.js'

export const SIM_RECENT_LIMIT = 60
export const SIM_SWEEP_INTERVAL_MS = 30_000

/** 仅@才回模式下仍放行的唤醒：点名（@/引用）、一次性开场、被点名后的定时延伸（等待超时/回合补发）、管理指令、承诺到期（答应了的事必须兑现）。主动冒泡(proactiveCheck)不放行。 */
const AT_ONLY_WAKE_KINDS = new Set<SimWakeReason['kind']>(['atMention', 'bootstrap', 'timeout', 'replyCheck', 'admin', 'commitment'])
const FORWARD_READ_ERROR = '无法确认原群消息或转发已不可用'

/**
 * 唤醒预判闸旁路：这些唤醒不经便宜模型预判、直达完整回合——
 * 被@/开场/管理天然高价值；session(活跃档)是管理员明确要的参与；timeout/replyCheck 是已参与回合的收尾延伸。
 */
const WAKE_GATE_BYPASS_KINDS = new Set<SimWakeReason['kind']>([...AT_ONLY_WAKE_KINDS, 'session', 'characterGoal'])

interface NudgeIngressOptions extends MessageActionOptions {
  binding?: AgentBindingSnapshot
  ingressId?: string
}

export interface SimulationRuntimePorts {
  redis: Parameters<typeof createSimSessionStore>[0]['redis']
  logger: { info(message: string): void; warn(message: string): void; error(message: string, error?: unknown): void }
  /** 每次调用重读（config 热更新即时生效） */
  getSection(): SimulationSection
  /** 解码后的宿主执行配置（YTapi 的 config 参数） */
  getExecutionConfig(): unknown
  /** 当前 bot 身份（多号时以事件的 self_id 为准） */
  getSelf(selfIdHint?: string | number, account?: PlatformAccountRef): { id: string; name: string; userId?: string }
  isAccountReady?(account: PlatformAccountRef): boolean
  /** Scope a turn to the current privacy state through its final synchronous transport guard. */
  beginMemoryTurn?(binding: AgentBindingSnapshot): Promise<{ isCurrent(): boolean; release(): void; signal: AbortSignal }>
  isMemoryInputAvailable?(account: PlatformAccountRef): boolean
  YTapi(requestData: ChatRequestData, config: unknown, signal?: AbortSignal, isCurrent?: ExecutionOptions['isCurrent'], ensureCurrent?: ExecutionOptions['ensureCurrent']): Promise<ChatResponse>
  /** Dynamic host credential fence before model content or tool arguments enter retained history. */
  allowsToolInput?(input: string): boolean
  /** Isolated, abortable model path for private reflection; absent means no background model calls. */
  reflectCharacter?(requestData: ChatRequestData, config: unknown, signal: AbortSignal, isCurrent?: ExecutionOptions['isCurrent'], ensureCurrent?: ExecutionOptions['ensureCurrent']): Promise<ChatResponse>
  /** Bounded semantic review. Production wires this to an abortable, tool-free model call. */
  reviewCharacter?(requestData: ChatRequestData, config: unknown, signal: AbortSignal, isCurrent?: ExecutionOptions['isCurrent'], ensureCurrent?: ExecutionOptions['ensureCurrent']): Promise<ChatResponse>
  /** Tool-free classification of the triggering message for deferred social actions. */
  judgeSocialPermission?(requestData: ChatRequestData, config: unknown, signal: AbortSignal, isCurrent?: ExecutionOptions['isCurrent'], ensureCurrent?: ExecutionOptions['ensureCurrent']): Promise<ChatResponse>
  fetchCharacterFeed?(url: string, kind: 'rss' | 'github'): Promise<CharacterFeedItem[]>
  runCharacterWorker?(task: CharacterWorkerTask, scope: CharacterScope, signal: AbortSignal): Promise<CharacterWorkerResult>
  characterWorkerAvailable?(): boolean
  /** B站卡片分享:按关键词或链接解析视频并生成 QQ 卡片 JSON(发送由 runtime 统一出站) */
  resolveBilibiliCard?(input: { query?: string; url?: string }): Promise<{ ok: boolean; error?: string; title?: string; cardJson?: string }>
  /** 视觉侧模型把图片转成文字描述（主模型纯文本时 simGetMessageImages 的看图走这里）；返回 null/空 表示描述不可用 */
  describeImages?(images: readonly MessageImage[], context: { groupId: string; label: string; isCurrent?: () => boolean; signal?: AbortSignal }): Promise<string | null>
  messageActions?: MessageActionPort
  /** Checks which platform accounts this host can execute for. The default host accepts QQ groups. */
  handlesTarget?(target: ConversationAddress): boolean
  /** Mode selection may suppress execution while this host still owns recall and storage. */
  allowsSimulation?(target: ConversationAddress): boolean
  /** Process hosts acknowledge a durable inbox entry after this runtime records its wake. */
  durableIngress?: boolean
  readHealthStyleMemory?(): Promise<unknown>
  /** Compatibility transport for native segments emitted by existing QQ tools and cards. */
  sendGroupMessage?(groupId: string, segments: unknown[], selfId?: string, options?: SimSendOptions): Promise<SimTransportReceipt>
  getPersona(groupId: string, selfId: string, target?: ConversationAddress): { personaId?: string; persona: PersonaText; systemContent: string; personaGuard?: PersonaGuardConfig; binding?: AgentBindingSnapshot }
  readQuotedMessage?(target: ConversationAddress, messageId: string, guard: MessageActionOptions): Promise<IncomingMessage | undefined>
  supportsForwardRead?(target: ConversationAddress): boolean
  readForward?(target: ConversationAddress, source: ForwardReference, guard: MessageActionOptions): Promise<ForwardContent | undefined>
  supportsMessageImages?(target: ConversationAddress): boolean
  readMessageImages?(target: ConversationAddress, source: { messageId: string; quotedMessageId?: string }, guard: MessageImageReadOptions): Promise<readonly MessageImage[] | undefined>
  readMessageFile?(target: ConversationAddress, source: { messageId: string; quotedMessageId?: string }, fileIndex: number, guard: MessageFileReadOptions): Promise<AgentFileBytes | undefined>
  listConversationFiles?(target: ConversationAddress, guard: FileReadGuard): Promise<ConversationFileCatalog | undefined>
  readConversationFile?(target: ConversationAddress, entry: ConversationFileEntry, guard: ConversationFileReadOptions): Promise<AgentFileBytes | undefined>
  readPublicFile?(url: string, guard: FileReadGuard): Promise<AgentFileBytes>
  isMessageRecalled?(target: ConversationAddress, messageId: string): Promise<boolean>
  /** 仿真回合额外放通的既有工具（toolPolicy 解析出的实际放通名清单；从 localToolRegistry 取实例） */
  getExtraTools?(names: string[]): import('../../toolSupport/infrastructure/AbstractTool.js').AbstractTool[]
  /** Only hosts whose registry uses the neutral AgentTool contract may opt in. */
  extraToolsPlatformNeutral?: boolean
  isExtraToolAutonomous?(name: string): boolean
  /** Explicit tools that use platform bindings in place of a native QQ event. */
  getBoundTools?(target: ConversationAddress): AbstractTool[]
  /** 注册表工具名清单（toolPolicy open 模式的默认能力面）；缺省时安全回落 legacy 白名单行为 */
  listRegistryToolNames?(): { builtIn: string[]; all: string[] }
  /** 本群近期主线摘要（中期记忆）；无则空串 */
  getGroupDigest?(groupId: string, options?: { after?: number }): string
  /** 近两天情节记忆文本（"这两天聊过/做过什么"）；无则空串 */
  getRecentEpisodesText?(groupId: string, options?: { after?: number; viewer?: PersonaScope }): string
  readConversationMemory?(target: ConversationAddress, viewer: PersonaScope, isCurrent?: () => boolean): Promise<{ digest: string; episodes: string }>
  readGroupMemory?(target: ConversationAddress, viewer: PersonaScope, sourceId: string | undefined, isCurrent: () => boolean): Promise<string>
  isGroupMemoryCurrent?(target: ConversationAddress, expected: string, includeWorkflows: boolean, isCurrent: () => boolean): Promise<boolean>
  recordGroupReply?(target: ConversationAddress, isCurrent: () => boolean): Promise<void>
  /** 委托记忆（群友托付记的事，原文锚定）；无/失败=空数组，绝不阻塞唤醒 */
  loadDelegatedMemories?(scope: string | AgentConversationScope): Promise<unknown[]> | unknown[]
  /** 长程语义召回（更早的相关聊天片段，来自语义记忆混合检索）；无/超时/失败=空串，绝不阻塞唤醒 */
  getSemanticRecall?(groupId: string, query: string, options: { botId: string; personaId: string; filterSource: ((source: PersonMemorySource, text: string) => Promise<boolean>) & { refresh(): void } }): Promise<string>
  /** Scoped Core retrieval; the address is host evidence, never a model argument. */
  readSemanticMemory?(target: ConversationAddress, query: string, isCurrent: () => boolean, signal?: AbortSignal, excludeMessageIds?: readonly string[]): Promise<AgentSemanticMemoryRecall | undefined>
  readHistory?(target: ConversationAddress, input: Record<string, unknown>, source: AgentHistoryRequestSource, isCurrent: () => boolean, signal?: AbortSignal): Promise<AgentHistoryRecall>
  /** 说话风格参考（群级表达学习 + 全局表达学习的注入文本）；无则空串 */
  getStyleDigest?(groupId: string): Promise<string> | string
  /** 读归档消息（按人挖口头禅的数据源）：近 N 天该群消息（userId+text） */
  readArchiveMessages?(groupId: string, days: number): Promise<{ userId: string; text: string }[]>
  /** P0 反污染：风格学习要跳过的机器人 QQ（pluginSettings.botUserIds + 自家账号） */
  getStyleBotUserIds?(): string[]
  /** 戳群成员（B2：回应拍一拍/主动逗熟人） */
  pokeMember?(groupId: string, userId: string, selfId?: string): Promise<{ ok: boolean; error?: string }>
  /** 唤醒预判闸：低信号唤醒先判断值不值得进完整回合；返回 null = 预判不可用（fail-open 放行） */
  wakeGateJudge?(input: { reason: string; messages: { name: string; text: string; atSelf: boolean }[] }, isCurrent?: ExecutionOptions['isCurrent']): Promise<{ engage: boolean; reason?: string } | null>
  /** QQ空间互动：看指定成员的最近说说 / 点赞 / 评论（凭据由装配层处理；内容已在上层脱敏） */
  qzoneInteract?(input: { action: 'visit' | 'like' | 'comment'; userId?: string; tid?: string; text?: string }, target: ConversationAddress, options?: SimSendOptions): Promise<{ ok: boolean; error?: string; feeds?: { tid: string; time: string; text: string; likes: number }[] }>
  /** 人物核心档案提取（侧路小模型）：近期消息 → 跨群身份级事实补丁 */
  personProfileExtract?: PersonProfileExtractor
  /** 生活线真实数据源：resolve 按 kind 用真实搜索定位（找不到返回 error，拒绝编造）；sync 拉取真实更新 */
  lifeThreadResolve?(input: { title: string }): Promise<{ ok: true; sourceId: string; title: string; episode?: number } | { ok: false; error: string }>
  lifeThreadSync?(input: { sourceId: string; title: string; lastEpisode?: number }): Promise<{ newNotes: string[]; episode?: number } | { error: string }>
  /** 群成员列表（B3）：[{userId, nick}] */
  getGroupMembers?(groupId: string, selfId?: string): Promise<{ userId: string; nick: string }[]>
  readGroupMembers?(target: ConversationAddress, signal: AbortSignal, isCurrent: () => boolean): Promise<ConversationMembersSnapshot | undefined>
  /** 合并转发内容（B4）：逐条正文 + 图片 URL 列表（按 [图片#N] 编号）+ 内嵌转发 id 列表（可递归展开） */
  getForwardContent?(forwardId: string, selfId?: string, options?: MessageActionOptions): Promise<{ lines: string[]; error?: string; total?: number; truncated?: boolean; nestedForwardIds?: string[]; imageUrls?: string[] }>
  /** 精选收藏表情（B6）：把消息附图收进表情包库（走完整 VLM 审核打标管线） */
  collectStickerImage?(groupId: string, url: string): Promise<{ ok: boolean; error?: string }>
  /** 仿真回合结束补记情节（仿真群不走主链路，情节记忆会断档） */
  recordEpisode?(input: { groupId: string; userId?: string; userName?: string; summary: string; reply: string; source?: PersonaScope;
    binding?: AgentBindingSnapshot; at?: number; messageIds?: string[]; replyIds?: string[]; isCurrent?: () => boolean }): void | Promise<void>
  /** 本群专属梗提取（侧路小模型，返回原始模型文本；runtime 负责容错解析） */
  memeExtract?(messages: { name: string; text: string }[]): Promise<string>
  /** 令牌账本：仿真回合/梗提取的归组记录 */
  recordTokens?(input: { scope: string; stage: string; model?: string; usage?: unknown; ms?: number }): void
  /** 只读观察实际工具协议回复；返回值不参与执行，观察失败不影响业务。 */
  recordToolResult?(result: SimToolResultObservation): void
  /** 当日该群花费（元，读令牌账本；预算闸用） */
  getTodaySpendCny?(scope: string): number
  /** 仿真回合表情冷却（毫秒；读 emojiSystem.postSendCooldownMs） */
  getEmojiCooldownMs?(): number
  /** 下载图片为 base64（simGetMessageImages 用；SSRF/大小限制由实现负责） */
  fetchImageBase64?(url: string, options?: MessageActionOptions): Promise<{ mime: string; base64: string; error?: undefined } | { mime?: undefined; base64?: undefined; error: string }>
  now?(): number
  random?(): number
}

export interface SimulationRuntime {
  ingest(message: IncomingMessage, options?: MessageActionOptions): Promise<boolean>
  ingestNudge(event: PlatformNudgeEvent, options?: NudgeIngressOptions): Promise<boolean>
  start(): Promise<void>
  stop(): void
  drain(): Promise<void>
  sweepOnce(): Promise<void>
  enableGroup(groupId: string): Promise<string>
  disableGroup(groupId: string): Promise<string>
  /** 按群回复模式：atOnly=仅被@才回（消息照常入库），auto=自主，active=自主·活跃（持续活动按节奏主动跟进）；缺省=query 查询 */
  setGroupReplyMode(groupId: string, mode?: 'atOnly' | 'auto' | 'active' | 'query'): Promise<string>
  groupStatus(groupId: string): Promise<string>
  resetGroup(groupId: string): Promise<string>
  listMemories(groupId: string): Promise<string>
  listAffinity(groupId: string, askerId?: string): Promise<string>
  ingestPoke(e: { group_id?: string | number; user_id?: string | number; self_id?: string | number; target_id?: string | number }, target?: ConversationAddress): Promise<boolean>
  /** A3 撤回处理：从 unread/recent 里移除已撤回的消息 */
  handleRecall(e: { group_id?: string | number; message_id?: string | number }, target?: ConversationAddress): Promise<boolean>
  conversationKey(target: ConversationAddress): Promise<string | null>
  /** 承诺账本查询口：该群当前是否仿真生效（commitmentTool 创建 agent 类承诺前的闸） */
  isGroupActive(groupId: string): boolean
  isConversationActive(target: ConversationAddress): Promise<boolean>
  groupTextBudget(target: ConversationAddress, at: number): Promise<{
    maxTurns: number; dailyCostCny: number; minGapMs: number; carriedTurns: number; todayCostCny: number
  }>
  /** 承诺账本兑现口：agent 类承诺到期唤醒仿真回合（timer 类 1s 直醒；群未生效则忽略） */
  wakeForCommitment(groupId: string, detail: string, options?: CommitmentRunOptions, target?: ConversationAddress): Promise<CommitmentRunResult>
  /** 控制台总览：全部生效群的状态列表 */
  overview(): Promise<Record<string, unknown>>
  describeGroup(groupId: string): Promise<Record<string, unknown>>
  controlCharacter(groupId: string, action: 'pause' | 'resume' | 'cancel-goal' | 'pause-goal' | 'resume-goal' | 'delete-memory', id?: string): Promise<string>
  controlActivity(groupId: string, action: CharacterActivityOperation, id?: string, payload?: Record<string, unknown>): Promise<string>
  getInitialPrompt(groupId: string): Promise<string>
  setInitialPrompt(groupId: string, text: string): Promise<string>
  /** 控制台：设置/清除按群每日金额上限（-1=不限，0=清除回落，>0=上限） */
  setGroupBudget(groupId: string, cap: number): Promise<string>
  /** 控制台：设置/清除按群每日回合上限（-1=不限，0=清除回落，>0=上限） */
  setGroupTurnsCap(groupId: string, cap: number): Promise<string>
  /** 控制台：设置/清除全局默认每日金额上限（cny<=0 清除，回落 yaml） */
  setDefaultBudget(cny: number): Promise<string>
  /** 控制台「人物记忆」：列出/删除跨群人物档案（透明化与被遗忘权） */
  listPersonProfiles(): Promise<{ userId: string; name?: string; interests: string[]; taboos: string[]; traits?: string[]; facts?: string[]; globalAffinity?: number; updatedAt?: number }[]>
  deletePersonProfile(userId: string): Promise<boolean>
  deletePersonProfileField(userId: string, field: string, value?: string): Promise<unknown>
  /** 控制台「作息与生活」页：总览 + 修改作息 */
  lifeOverview(): Promise<{ rhythm: { sleepFrom: number; sleepTo: number; setBy?: string }; threads: unknown[]; now: { hour: number; sleeping: boolean } }>
  setLifeRhythm(from: number, to: number): Promise<string>
  /** 控制台：健康哨兵告警列表 */
  getHealthAlerts(): Promise<{ alerts: unknown[]; checkedAt: number }>
}

interface SimSendOptions extends MessageActionOptions {
  binding?: AgentBindingSnapshot
}

interface SimTransportReceipt {
  ok: boolean
  error?: string
  messageId?: string | number
  unknown?: boolean
}

interface PendingWake { timer: ReturnType<typeof setTimeout>; reason: SimWakeReason; bindingToken: string | undefined }
interface CommitmentExecution {
  options: CommitmentRunOptions
  result: CommitmentRunResult
  started: boolean
  finalized: boolean
}

function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, boundedTimerDelay(ms))) }
function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function safeText(resolve: () => string | undefined): string {
  try { return String(resolve() || '') } catch { return '' }
}

/** 额外工具 e.reply 的负载归一：字符串→文本段；单个段对象/段数组原样透传。 */
function normalizeReplyPayload(payload: unknown): unknown[] {
  if (typeof payload === 'string') return [{ type: 'text', data: { text: payload } }]
  if (Array.isArray(payload)) return payload.map(segment => typeof segment === 'string' ? { type: 'text', data: { text: segment } } : segment)
  if (payload && typeof payload === 'object' && typeof (payload as { type?: unknown }).type === 'string') return [payload]
  return [{ type: 'text', data: { text: String(payload ?? '') } }]
}

export function createSimulationRuntime(ports: SimulationRuntimePorts): SimulationRuntime {
  const { logger } = ports
  const now = ports.now ?? Date.now
  const random = ports.random ?? Math.random
  const store: SimSessionStore = createSimSessionStore({ redis: ports.redis, logger, now })
  const initialPromptStore = ports.durableIngress ? createInitialPromptStore(ports.redis) : undefined
  const personMemory = createPersonMemoryStore({ redis: ports.redis, now })
  const workspaceFor = (scope: CharacterScope) => createCharacterWorkspace({ redis: ports.redis, scope, now })
  const retainEvidenceRefs = async (scope: CharacterScope) => (await workspaceFor(scope).list()).flatMap(work => work.versions.flatMap(version => version.evidenceRefs))
  const characters = createCharacterStore({ redis: ports.redis, now, retainEvidenceRefs })
  const subscriptionsFor = (scope: CharacterScope) => createCharacterSubscriptions({ redis: ports.redis, scope, now, ...(ports.fetchCharacterFeed ? { fetchFeed: ports.fetchCharacterFeed } : {}) })
  const sharedFor = (scope: CharacterScope) => createCharacterSharedSelf({ redis: ports.redis, scope, now })
  const reflectionFor = (scope: CharacterScope) => createCharacterReflection({ redis: ports.redis, scope, now, retainEvidenceRefs })
  const background = new Set<string>()
  const backgroundControllers = new Set<AbortController>()
  const backgroundByGroup = new Map<string, AbortController>()
  const recoveredCharacters = new Set<string>()
  let stopped = false

  function targetFor(groupId: string, botId: string): ConversationAddress {
    return decodeSimulationAddressKey(groupId) ?? qqSimulationAddress(groupId, botId)
  }

  function handlesTarget(target: ConversationAddress): boolean {
    const qq = isQqSimulationAddress(target)
    return (qq || !!ports.messageActions) && (ports.handlesTarget?.(target) ?? qq)
  }

  function personaFor(target: ConversationAddress): ReturnType<SimulationRuntimePorts['getPersona']> {
    if (!handlesTarget(target)) throw new Error('仿真会话不属于当前宿主')
    const resolved = ports.getPersona(target.id, target.account.id, target)
    if (resolved.binding && conversationAddressKey(resolved.binding.target) !== conversationAddressKey(target)) {
      throw new Error('仿真角色绑定与会话地址不一致')
    }
    if (resolved.binding?.source === 'configured') return { ...resolved, personaId: agentPersonaScopeId(resolved.binding.agentId) }
    if (!isQqSimulationAddress(target)) throw new Error('仿真会话需要显式角色绑定')
    return resolved
  }

  function selfFor(target: ConversationAddress): ReturnType<SimulationRuntimePorts['getSelf']> {
    return ports.getSelf(target.account.id, target.account)
  }

  function characterScopeFor(target: ConversationAddress, personaId: string): CharacterScope {
    const { botId, scene } = personMemoryAddress(target)
    return { botId, personaId, groupId: scene.id }
  }

  function displayConversation(groupId: string): string {
    const target = decodeSimulationAddressKey(groupId)
    return target ? `${target.id}（${target.account.platform}/${target.account.namespace} ${target.account.id}）` : groupId
  }

  function scopeFor(groupId: string, botId = ports.getSelf().id): CharacterScope {
    const target = targetFor(groupId, botId)
    return characterScopeFor(target, personaFor(target).personaId || 'default')
  }
  // A console process may have no adapter identity, or an unrelated default bot.
  // Only an actual session binding establishes ownership of character data.
  function boundScopeFor(groupId: string, botId?: string): CharacterScope | null {
    if (!botId) return null
    const target = targetFor(groupId, botId)
    return target.account.id === botId && handlesTarget(target) ? scopeFor(groupId, botId) : null
  }
  function scopedStore(scope: CharacterScope, binding?: AgentBindingSnapshot): SimSessionStore {
    return createSimSessionStore({ redis: ports.redis, logger, now, characterScope: scope,
      ...(binding?.source === 'configured' ? { memoryScope: binding } : {}),
    })
  }
  async function sceneMemories(groupId: string, at = now()): Promise<SimMemoryEntry[]> {
    const state = liveStates.get(groupId) ?? await store.load(groupId)
    const botId = state.botId
    if (!botId) return normalizeMemoryList(await store.loadMemories(groupId), at)
    const target = targetFor(groupId, botId)
    const resolved = personaFor(target)
    const scope = characterScopeFor(target, resolved.personaId || 'default')
    return normalizeMemoryList(await scopedStore(scope, resolved.binding).loadMemories(groupId), at, isQqSimulationAddress(target) ? undefined : isSimulationUserId)
  }
  async function redactSceneMessages(scope: CharacterScope, messages: SimMessage[]): Promise<SimMessage[]> {
    const scene = { kind: 'group' as const, id: scope.groupId }
    const cutoff = (await personMemory.getSceneRedactions({ identity: scope, scene })).invalidatedAt
    const snapshots = new Map<string, Awaited<ReturnType<typeof personMemory.getRedactions>>>()
    const readRedactions = async (subjectId: string) => {
      let snapshot = snapshots.get(subjectId)
      if (!snapshot) { snapshot = await personMemory.getRedactions({ identity: scope, subjectId }); snapshots.set(subjectId, snapshot) }
      return snapshot
    }
    const out: SimMessage[] = []
    for (const message of messages) {
      const excerpt = message.text || (message.forwardId ? '[合并转发]' : message.imageCount > 0 ? '[图片]' : message.files?.length ? '[文件]' : '')
      const source = { scene, authorId: message.userId, messageId: String(message.messageId || `sim:${message.at}:${message.seq}`), at: message.at, excerpt }
      if (isPersonMemoryRedacted(source, message.text, await readRedactions(message.userId))) continue
      let filtered = message
      if (message.quoteSource) {
        if (message.quoteSource.invalidatedAt !== cutoff) filtered = withoutResolvedQuote(message)
      } else if (cutoff > 0 && (message.quoteText || message.quoteImageUrls)) {
        // Legacy quote snapshots lack provenance for their content.
        filtered = { ...message }
        delete filtered.quoteText; delete filtered.quoteImageUrls
      }
      if (cutoff > 0 && message.at <= cutoff && filtered.forwardId) {
        filtered = { ...filtered }
        delete filtered.forwardId
      }
      out.push(filtered)
    }
    return out
  }

  function withoutResolvedQuote(message: SimMessage): SimMessage {
    const filtered = { ...message, quoteToSelf: false }
    delete filtered.quoteAuthor; delete filtered.quoteText; delete filtered.quoteImageUrls
    delete filtered.quoteSource
    delete filtered.replyToUserId
    return filtered
  }

  const needsQuoteForWake = (message?: SimMessage) => Boolean(message?.quoteSource && message.quoteToSelf && !message.atSelf)
  async function revokeSharedDerived(groupId: string, scope: CharacterScope): Promise<void> {
    const active = new Set((await sharedFor(scope).projection()).map(entry => entry.id))
    const source = await characters.load(scope)
    const revoked = source.memories.filter(memory => memory.sharedSources?.some(id => !active.has(id)))
    const goals = source.goals.filter(goal => ['active','waiting','paused'].includes(goal.status) && goal.sharedSources?.some(id => !active.has(id)))
    if (revoked.length || goals.length) {
      await store.invalidateActivity(groupId)
      await characters.update(scope, current => {
        let next = current
        for (const memory of revoked) if (next.memories.some(item => item.id === memory.id)) next = deleteCharacterMemory(next, memory.id, now())
        for (const goal of goals) if (next.goals.some(item => item.id === goal.id && ['active','waiting','paused'].includes(item.status))) next = transitionCharacterGoal(next, goal.id, 'abandoned', { now: now(), lastOutcome: '共享自我来源已撤销，停止派生目标' })
        return next
      })
      await store.invalidateActivity(groupId)
      const live = liveStates.get(groupId)
      if (live) {
        live.agentHistory = []
        await store.save(groupId, live)
      }
    }
    await workspaceFor(scope).pruneShared([...active])
  }
  async function recoverCharacter(scope: CharacterScope): Promise<void> {
    const key = JSON.stringify(scope)
    if (recoveredCharacters.has(key)) return
    await characters.update(scope, current => recoverInterruptedCharacter(current, now()))
    recoveredCharacters.add(key)
  }

  function safeNumber(resolve: () => number | undefined): number {
    try { return Number(resolve() || 0) || 0 } catch { return 0 }
  }

  function parseSimImages(resultText: string, max = 2): { mime: string; base64: string }[] {
    try {
      const parsed = JSON.parse(resultText) as { images?: { mime?: string; base64?: string }[] }
      return (parsed?.images || []).filter((image): image is { mime: string; base64: string } => Boolean(image?.mime && image?.base64)).slice(0, Math.max(1, max))
    } catch { return [] }
  }

  /** 工具执行统一包装：事件含 reply 绑定（文本段/段数组归一 + message_id 回执） */
  async function runSimTool(tool: { name?: string; execute(args: Record<string, unknown>, event: unknown): Promise<unknown> }, args: Record<string, unknown>, event: AgentBindingTurn & { group_id?: number; self_id: string }, actor: SimulationActor, reply: (payload: unknown) => Promise<unknown>, report?: (status: 'succeeded' | 'failed') => void, taskId?: string): Promise<string> {
    try {
      const result = await tool.execute(args, {
        ...event,
        ...(actor.kind === 'user' && actor.userId ? { user_id: /^\d+$/.test(actor.userId) ? Number(actor.userId) : actor.userId, sender: { user_id: actor.userId, nickname: actor.userName || '' } } : {}),
        simulation: true,
        simulationActor: actor,
        simulationReportOutcome: report,
        ...(taskId ? { simulationTaskId: taskId } : {}),
        reply,
      })
      return typeof result === 'string' ? result : JSON.stringify(result) ?? 'null'
    } catch (error) {
      if (error && typeof error === 'object' && 'uncertain' in error && error.uncertain === true) return JSON.stringify({ kind: 'tool_outcome', status: 'unknown', error: { message: safeToolErrorText(String(tool.name || ''), error) } })
      return safeToolErrorText(String(tool.name || ''), error)
    }
  }

  const running = new Set<string>()
  const fileTurnControllers = new Set<AbortController>()
  const scheduledTurns = new Set<Promise<void>>()
  const activeSweeps = new Set<Promise<void>>()
  const pendingWakes = new Map<string, PendingWake>()
  const ingressQueue = new Map<string, Promise<void>>()
  const commitmentQueue = new Map<string, Promise<CommitmentRunResult>>()
  const commitmentRuns = new Map<string, Promise<CommitmentRunResult>>()
  const retryTimers = new Map<string, PendingWake>()
  /** 回合进行中的群 → 共享内存状态。回合期间 ingest 直接改这份对象，避免双写者互覆。 */
  const liveStates = new Map<string, SimSessionState>()
  /** wait 实现：群 → 待踢醒的 resolver（新消息到达即全部触发重新判定） */
  const waiters = new Map<string, Set<() => void>>()
  /** 仿真回合表情冷却：群 → 上次成功发表情时间 */
  const emojiLastSentAt = new Map<string, number>()
  /** 戳人频率护栏：群 → 历史戳的时间戳（每小时上限 6 次，防骚扰） */
  const pokeTimes = new Map<string, number[]>()
  let sweeper: ReturnType<typeof setInterval> | null = null
  let overridesCache: SimGroupOverrides | null = null
  // 每日限额触发时的群内提示:同群 30 分钟最多一条,避免刷屏
  const limitNoticeAt = new Map<string, number>()
  // B站卡片分享冷却:同群 20 分钟一张,保持「偶尔甩一张」的克制感
  const videoCardAt = new Map<string, number>()
  let overridesLoadedAt = 0
  let healthSentinelLastRun = 0
  let knownGroupsCache: string[] = []

  function runtimeConfig(groupId?: string): SimRuntimeConfig {
    return resolveSimulationGroupConfig(ports.getSection(), overridesCache, groupId)
  }

  async function groupBudgetUsage(groupId: string, at: number) {
    const carried = ports.durableIngress ? await store.loadBudgetCarryover(groupId, at) : null
    const cost = safeNumber(() => ports.getTodaySpendCny?.(groupId)) + (carried?.costCny ?? 0)
    return { carriedTurns: carried?.turns ?? 0, todayCostCny: Math.round(cost * 10_000) / 10_000 }
  }

  async function checkGroupWakeBudget(state: SimSessionState, cfg: SimRuntimeConfig, groupId: string, reason: SimWakeReason | null = null) {
    const at = now()
    const { carriedTurns, todayCostCny } = await groupBudgetUsage(groupId, at)
    return checkWakeBudget(state, cfg, at, todayCostCny, reason, groupId, carriedTurns)
  }

  async function groupTextBudget(target: ConversationAddress, at: number) {
    await refreshGroupState()
    const groupId = simulationAddressKey(target)
    const cfg = runtimeConfig(groupId)
    return {
      maxTurns: cfg.turn.groups[groupId] ?? cfg.turn.maxTurnsPerDay,
      dailyCostCny: cfg.budget.groups[groupId] ?? cfg.budget.dailyCostCny,
      minGapMs: Math.max(1, cfg.turn.minSendGapMs),
      ...await groupBudgetUsage(groupId, at),
    }
  }

  /**
   * 群覆盖状态（.仿真 开/关 写 Redis）：60s 缓存 + 强制刷新。
   * 首次运行（从未写过覆盖）时把 yaml simulation.groups 种子进显式启用清单。
   */
  async function refreshGroupState(force = false): Promise<void> {
    if (!force && overridesCache && now() - overridesLoadedAt <= 60_000) return
    let overrides = await store.loadOverrides()
    if (overrides === null) {
      overrides = seedSimulationOverrides(ports.getSection())
      await store.saveOverrides(overrides)
    }
    overridesCache = overrides
    knownGroupsCache = await store.loadKnownGroups()
    overridesLoadedAt = now()
  }

  /** 群是否处于仿真模式：enabled 总开关 → 显式退出优先 → allGroups 默认全开 / 显式清单。 */
  function groupActive(cfg: SimRuntimeConfig, groupId: string): boolean {
    if (!cfg.enabled || !overridesCache) return false
    const target = decodeSimulationAddressKey(groupId)
    if (target && (!handlesTarget(target) || ports.allowsSimulation?.(target) === false)) return false
    return simulationGroupOverride(overridesCache, groupId) ?? cfg.allGroups
  }

  /** 承诺账本查询口：该群当前是否仿真生效（commitmentTool 创建 agent 类承诺前的闸） */
  function isSimulationGroup(groupId: string): boolean {
    return groupActive(runtimeConfig(), String(groupId || ''))
  }

  async function conversationKey(target: ConversationAddress): Promise<string | null> {
    const scoped = simulationAddressKey(target)
    if (!decodeSimulationAddressKey(scoped) || !handlesTarget(target)) return null
    if (!isQqSimulationAddress(target)) return scoped
    const { id, account } = target
    const legacy = liveStates.get(id) ?? await store.load(id)
    if (legacy.botId === account.id) return id
    const existing = liveStates.get(scoped) ?? await store.load(scoped)
    if (existing.botId === account.id) return scoped
    if (personaFor(target).binding?.source === 'configured') return scoped
    return legacy.botId ? null : id
  }

  async function isConversationActive(target: ConversationAddress): Promise<boolean> {
    if (ports.allowsSimulation?.(target) === false) return false
    const key = await conversationKey(target)
    if (!key) return false
    await refreshGroupState()
    return isSimulationGroup(key)
  }

  /** 承诺账本兑现口：agent 类承诺到期由 commitmentTick 调这里唤醒仿真回合（timer 类 1s 直醒） */
  async function wakeForCommitment(groupId: string, detail: string, options?: CommitmentRunOptions, target?: ConversationAddress): Promise<CommitmentRunResult> {
    if (target && (groupId !== target.id || (options?.botId && options.botId !== target.account.id))) {
      return { status: 'cancelled', sent: 0, error: '承诺会话地址与账号不一致' }
    }
    if (target && ports.allowsSimulation?.(target) === false) {
      return { status: ports.durableIngress ? 'deferred' : 'cancelled', sent: 0, error: '会话当前使用文字回复' }
    }
    const gid = target ? await conversationKey(target) : String(groupId || '')
    if (!gid || !options?.taskId || typeof options.isCurrent !== 'function') return { status: 'cancelled', sent: 0, error: '承诺执行缺少有效领取标识' }
    const executionOptions = target ? { ...options, botId: target.account.id } : options
    const expectedBinding = target ? personaFor(target).binding : undefined
    const key = `${gid}:${options.taskId}`
    const existing = commitmentRuns.get(key)
    if (existing) return existing
    const previous = commitmentQueue.get(gid)
    const execution: CommitmentExecution = { options: executionOptions, result: { status: 'failed', sent: 0, actions: 0, error: '回合未确认任何执行或发送' }, started: false, finalized: false }
    const operation = (async (): Promise<CommitmentRunResult> => {
      if (previous) await previous.catch(() => undefined)
      await startTurn(gid, { kind: 'commitment', detail: String(detail || '').slice(0, 4000) }, execution,
        expectedBinding ? agentBindingToken(expectedBinding) : undefined)
      return execution.result
    })().catch((error: unknown): CommitmentRunResult => {
      if (execution.finalized) return execution.result
      return { ...execution.result, status: execution.started ? 'unknown' : 'failed', error: error instanceof Error ? error.message : '承诺回合启动失败' }
    })
    commitmentRuns.set(key, operation); commitmentQueue.set(gid, operation)
    try { return await operation } finally {
      if (commitmentRuns.get(key) === operation) commitmentRuns.delete(key)
      if (commitmentQueue.get(gid) === operation) commitmentQueue.delete(gid)
    }
  }

  function notifyWaiters(groupId: string) {
    const set = waiters.get(groupId)
    if (!set) return
    for (const wake of [...set]) { try { wake() } catch { /* resolver 自防 */ } }
  }

  /** 白名单放通的既有工具（simulation.extraTools）：装配期合并进仿真回合工具面 */
  function resolveExtraTools(names: string[]): AbstractTool[] {
    if (!names.length || typeof ports.getExtraTools !== 'function') return []
    try {
      return ports.getExtraTools(names)
    } catch {
      return []
    }
  }

  /** 实际放通的既有工具名清单:open=内置安全面−减法+追加(自定义/敏感走 extraTools/allowTools);legacy=extraTools 白名单。
   *  端口缺省或解析异常都安全回落 legacy 行为——能力面只会更小不会更大。 */
  function resolveExtraToolNames(cfg: SimRuntimeConfig, groupId: string): string[] {
    const target = decodeSimulationAddressKey(groupId)
    if (target && !isQqSimulationAddress(target) && !ports.extraToolsPlatformNeutral) return []
    if (cfg.toolPolicy.mode === 'legacy' || typeof ports.listRegistryToolNames !== 'function') return cfg.extraTools
    try {
      const registry = ports.listRegistryToolNames()
      return resolveSimToolSurface({ policy: cfg.toolPolicy, builtInNames: registry.builtIn, extraTools: cfg.extraTools, groupId: target?.id ?? groupId })
    } catch {
      return cfg.extraTools
    }
  }

  function imageUrlsOf(parts: readonly MessagePart[], limit: number): string[] {
    const urls: string[] = []
    for (const part of parts) {
      if (part.kind !== 'image' || part.resource?.kind !== 'url' || part.resource.value.length > 1024) continue
      urls.push(part.resource.value)
      if (urls.length === limit) break
    }
    return urls
  }

  function alignSessionBinding(state: SimSessionState, binding?: AgentBindingSnapshot): boolean {
    const token = binding ? agentBindingToken(binding) : undefined
    if (state.bindingToken === token) return false
    // Adopt unversioned QQ sessions on their existing legacy route. A change
    // of ownership invalidates queued work and the model's old conversation.
    const changed = state.bindingToken !== undefined || binding?.source === 'configured'
    if (token) state.bindingToken = token
    else delete state.bindingToken
    if (!changed) return false
    const fresh = createDefaultSimSession(now(), runtimeConfig().agentPresetKeywords)
    state.unread = []
    state.recent = []
    state.modelSeenSeqs = []
    state.lastReadThroughSeq = state.seq
    state.lastAiSendAt = 0
    state.lastWakeAt = 0
    state.lastWakeReason = null
    state.wakeConfig = fresh.wakeConfig
    state.pendingWakeReasons = []
    delete state.queuedIngressWake
    delete state.confirmedMessageIds
    state.agentHistory = []
    state.conversation = fresh.conversation
    state.preSleepWait = fresh.preSleepWait
    state.nextProactiveCheckAt = 0
    state.nextReplyCheckAt = 0
    delete state.lastConfirmedChat
    state.lastProactiveCheckedSeq = state.seq
    delete state.offeredFollowUpIds
    delete state.lastPlayAlongWakeAt
    state.personProfileCursor = {seq:state.seq, at:0}
    state.memeCursor = {seq:state.seq, at:0}
    return true
  }

  async function queueIngress<T>(groupId: string, apply: () => Promise<T>): Promise<T> {
    const result = (ingressQueue.get(groupId) ?? Promise.resolve()).then(apply)
    const pending = result.then(() => {}, () => {})
    ingressQueue.set(groupId, pending)
    try { return await result } finally {
      if (ingressQueue.get(groupId) === pending) ingressQueue.delete(groupId)
    }
  }

  async function sessionForIncoming(groupId: string, botId: string, token: string | undefined, isCurrent: () => boolean): Promise<SimSessionState | null> {
    while (!stopped && isCurrent()) {
      const live = liveStates.get(groupId)
      const state = live ?? await store.load(groupId)
      if (!isCurrent()) return null
      if (state.botId && state.botId !== botId) {
        logger.warn(`[仿真] 群 ${groupId} 已绑定另一机器人，本账号不接管其会话`)
        return null
      }
      if (!live || state.bindingToken === token) return state
      await waitForArrival(groupId, 500)
    }
    return null
  }

  /** 会话延续：登记对话对象（≤5，最近优先）并刷新活跃窗口 */
  function markConversationEngaged(state: SimSessionState, userId: string, windowMs: number): void {
    if (!userId) return
    const nowAt = now()
    state.conversation.activeUntil = Math.max(state.conversation.activeUntil, nowAt + windowMs)
    state.conversation.interlocutorIds = [userId, ...state.conversation.interlocutorIds.filter(id => id !== userId)].slice(0, 5)
    state.conversation.lastTriggerUserId = userId
  }

  async function ingest(incoming: IncomingMessage, options?: MessageActionOptions): Promise<boolean> {
    const target = incoming.conversation
    if (ports.allowsSimulation?.(target) === false) return false
    if (ports.getSection().enabled === false) return false
    let key: string | null
    try { key = await conversationKey(target) } catch {
      logger.warn(`[仿真] 会话 ${target.id} 角色绑定无效，跳过本次入站`)
      return true
    }
    if (!key) {
      // Preserve ownership of a legacy QQ session when another account sees the same event.
      if (isQqSimulationAddress(target) && handlesTarget(target)) {
        await refreshGroupState()
        return isSimulationGroup(target.id)
      }
      return false
    }
    return queueIngress(key, () => ingestGroup(key, incoming, options))
  }

  async function ingestGroup(groupId: string, incoming: IncomingMessage, options?: MessageActionOptions): Promise<boolean> {
    const target = incoming.conversation
    const { account } = target
    await refreshGroupState()
    if (!isSimulationGroup(groupId)) return false
    if (options?.isCurrent?.() === false) return true
    const self = selfFor(target)
    if (self.id !== account.id) return true
    let scope: CharacterScope
    let binding: AgentBindingSnapshot | undefined
    let selfName = self.name
    let capturedBinding: string | undefined
    try {
      const resolved = personaFor(target)
      binding = resolved.binding
      capturedBinding = binding ? agentBindingToken(binding) : undefined
      if (incoming.binding && (conversationAddressKey(incoming.binding.target) !== conversationAddressKey(target) || agentBindingToken(incoming.binding) !== capturedBinding)) return true
      scope = characterScopeFor(target, resolved.personaId || 'default')
      if (resolved.binding?.source === 'configured') selfName = String(resolved.persona.name || self.name)
    } catch {
      logger.warn(`[仿真] 群 ${groupId} 角色绑定无效，跳过本次入站`)
      return true
    }
    const bindingCurrent = () => {
      try {
        const resolved = personaFor(target)
        return options?.isCurrent?.() !== false && (resolved.personaId || 'default') === scope.personaId &&
          (resolved.binding ? agentBindingToken(resolved.binding) : undefined) === capturedBinding
      } catch { return false }
    }
    const inAccountNamespace = (identity: PlatformAccountRef) => identity.platform === account.platform && identity.namespace === account.namespace
    if (!inAccountNamespace(incoming.sender)) return true
    const userId = incoming.sender.id
    const selfUserId = self.userId ?? self.id
    if (!isSimulationUserId(userId) || userId === selfUserId) return true
    const images = incoming.parts.filter(part => part.kind === 'image').length
    const files = simulationFileMetadata(incoming.parts)
    const state = await sessionForIncoming(groupId, self.id, capturedBinding, bindingCurrent)
    if (!state || !bindingCurrent() || !isSimulationGroup(groupId)) return true
    if (ports.durableIngress && incoming.messageId && state.recent.some(message => message.messageId === incoming.messageId)) return true
    const atSelf = incoming.directedToAccount
    const atOther = incoming.mentions.some(user => inAccountNamespace(user) && user.id !== selfUserId)
    let quote = incoming.quote
    let quoteSource: SimMessage['quoteSource']
    const quoteId = quote?.messageId
    const knownBotReply = Boolean(quoteId && state.bindingToken === capturedBinding && state.confirmedMessageIds?.includes(quoteId))
    const canReadImages = !!ports.readMessageImages
    const canReadFiles = !!ports.readMessageFile
    if (ports.readQuotedMessage && quoteId && !quote?.author && (!knownBotReply || (canReadImages && images === 0) || (canReadFiles && files.length === 0))) {
      quote = { messageId: quoteId, parts: [] }
      let original: IncomingMessage | undefined
      // Read only the id attached by the incoming event.
      if (quoteId !== incoming.messageId) {
        try { original = await ports.readQuotedMessage(target, quoteId, { isCurrent: bindingCurrent }) } catch { /* reply text still works */ }
      }
      if (original?.messageId === quoteId && original.text.length <= 4_000 && inAccountNamespace(original.sender) && isSimulationUserId(original.sender.id) &&
          Number.isSafeInteger(original.occurredAt) && original.occurredAt > 0 && original.occurredAt <= incoming.occurredAt &&
          conversationAddressKey(original.conversation) === conversationAddressKey(target)) {
        const scene = { kind: 'group' as const, id: scope.groupId }
        const excerpt = original.text || (original.parts.some(part => part.kind === 'file') ? '[文件]' : '引用消息')
        const source = { messageId: quoteId, authorId: original.sender.id, at: original.occurredAt, excerpt }
        const { invalidatedAt } = await personMemory.getSceneRedactions({ identity: scope, scene })
        const redactions = await personMemory.getRedactions({ identity: scope, subjectId: source.authorId })
        const staleBotReply = source.authorId === selfUserId && invalidatedAt > 0 && source.at <= invalidatedAt
        if (!staleBotReply && !isPersonMemoryRedacted({ scene, ...source }, excerpt, redactions)) {
          const count = canReadImages ? original.parts.filter(part => part.kind === 'image').length : 0
          const quotedFiles = canReadFiles ? simulationFileMetadata(original.parts) : []
          quoteSource = { messageId: quoteId, invalidatedAt,
            ...(count ? { image: { count, authorId: source.authorId, occurredAt: source.at } } : {}),
            ...(quotedFiles.length ? { file: { files: quotedFiles, authorId: source.authorId, occurredAt: source.at } } : {}) }
          quote = { messageId: quoteId, author: original.sender, text: original.text, parts: [],
            ...(original.senderName ? { authorName: sanitizeUntrustedText(original.senderName.replace(/\s+/gu, ' ').trim()).slice(0, 80) } : {}) }
        }
      }
      if (!bindingCurrent() || !isSimulationGroup(groupId)) return true
    }
    const quotedUserId = quote?.author && inAccountNamespace(quote.author) ? quote.author.id : undefined
    const quoteToSelf = quotedUserId === selfUserId || knownBotReply
    const text = incoming.text.replace(/\s+/g, ' ').trim()
      || (atSelf ? '@你' : atOther ? '@了某人' : '')
    const forwardId = incoming.parts.find((part): part is Extract<MessagePart, { kind: 'forward' }> =>
      part.kind === 'forward' && part.id.length > 0 && part.id.length <= 256)?.id
    if (!text && images === 0 && !files.length && !quoteSource?.file?.files.length && !forwardId) return true
    if (text && /^[#./\\]/.test(text) && !atSelf && !quoteToSelf) return true

    if (ports.durableIngress) {
      // Register before saving. Replaying an inbox entry after an interrupted
      // save can then find its conversation and its pending wake on disk.
      await store.addKnownGroup(groupId)
    } else if (isDuplicateMessageId(incoming.messageId, [conversationAddressKey(target)])) return true
    const cfg = runtimeConfig()
    alignSessionBinding(state, binding)
    state.botId = self.id
    state.seq += 1
    const imageUrls = imageUrlsOf(incoming.parts, 2)
    const quoteAuthor = quote?.authorName || (quotedUserId
      ? state.recent.find(m => m.userId === quotedUserId)?.name || `群友${quotedUserId.slice(-4)}` : '')
    const quoteText = sanitizeUntrustedText((quote?.text || '').replace(/\s+/g, ' ').trim())
    const quoteImageUrls = imageUrlsOf(quote?.parts ?? [], 3)
    const sanitizedText = sanitizeUntrustedText(text)
    const message: SimMessage = {
      seq: state.seq,
      messageId: incoming.messageId ?? null,
      userId,
      name: incoming.senderName || userId,
      text: sanitizedText.slice(0, cfg.turn.messageTextMaxChars),
      ...(sanitizedText.length > cfg.turn.messageTextMaxChars ? { textTruncated: true } : {}),
      at: incoming.occurredAt,
      atSelf,
      ...(atOther ? { atOther: true } : {}),
      ...(incoming.mentions.length ? { mentionUserIds: [...new Set(incoming.mentions.filter(inAccountNamespace).map(user => user.id))].slice(0, 20) } : {}),
      quoteToSelf,
      ...(quote && !quoteToSelf ? {
        ...(quotedUserId ? { replyToUserId: quotedUserId } : {}),
        ...(quoteAuthor ? { quoteAuthor } : {}),
      } : {}),
      ...(quoteText ? { quoteText: quoteText.length > 160 ? `${quoteText.slice(0, 159)}…` : quoteText } : {}),
      ...(quoteSource ? { quoteSource } : {}),
      ...(quoteImageUrls.length ? { quoteImageUrls } : {}),
      ...(forwardId ? { forwardId } : {}),
      imageCount: images,
      ...(files.length ? { files } : {}),
      ...(imageUrls.length ? { imageUrls } : {}),
      kind: 'text',
    }
    state.unread.push(message)
    if (state.unread.length > cfg.turn.unreadLimit) state.unread = state.unread.slice(-cfg.turn.unreadLimit)
    state.recent.push(message)
    if (state.recent.length > SIM_RECENT_LIMIT) state.recent = state.recent.slice(-SIM_RECENT_LIMIT)
    state.lastIncomingAt = message.at
    if (message.messageId !== null && message.text && !message.forwardId) {
      try { await scopedStore(scope).registerPersonSource(userId, {
        scene: { kind: 'group', id: scope.groupId }, authorId: userId, messageId: String(message.messageId), at: message.at, excerpt: message.text.slice(0, 400)
      }) } catch (error) { logger.warn(`[仿真] 人物来源登记失败：${error instanceof Error ? error.message : String(error)}`) }
    }
    resetPreSleepWait(state)

    let reason: SimWakeReason | null = null
    if (!state.bootstrapSent) {
      reason = message.atSelf || message.quoteToSelf ? { kind: 'atMention', seq: message.seq } : { kind: 'bootstrap', seq: message.seq }
      state.bootstrapSent = true
    } else {
      const hourNow = new Date(now() + 8 * 3600_000).getUTCHours()
      // 插话熔断：我上次发言后有第三人插过话（recent 只含群友消息，当前消息已入列但按 userId 自然排除）——
      // 对话对象这条更可能是接那人的话而不是对我说的，不算延续唤醒。宁可漏接不要抢话。
      const interveningSinceBotTurn = state.lastAiSendAt > 0
        && state.recent.some(m => m.at > state.lastAiSendAt && m.userId !== message.userId)
      reason = evaluateWakeTrigger(message, state.wakeConfig, { selfId: selfUserId, selfName, random, conversation: state.conversation, interveningSinceBotTurn, activityFactor: cfg.rhythm.enabled ? activityFactor(hourNow) : 1 })
    }
    // 管理员设定的「仅@才回」优先于一切触发器（含 AI 自设唤醒）：非点名类唤醒压掉。
    // 消息照常入库——AI 被点名醒来后仍可读到全部内容；定时器/管理类唤醒是被点名后的延伸，不受影响。
    const atOnlyGroup = (overridesCache?.atOnly || []).includes(groupId)
    if (reason && atOnlyGroup && !AT_ONLY_WAKE_KINDS.has(reason.kind)) reason = null
    // 生物节律：睡眠窗口内非点名唤醒全部压掉（真人在睡觉；被@会醒，这是唯一的例外）
    if (reason && cfg.rhythm.enabled) {
      const rhythmWin = await loadRhythmWindow(cfg, scope)
      const hour = new Date(now() + 8 * 3600_000).getUTCHours()
      if (isSleeping(hour, rhythmWin) && !AT_ONLY_WAKE_KINDS.has(reason.kind)) reason = null
    }
    // 自主·活跃档：群里持续有动静时按节奏主动醒来跟进剧情，不等点名。
    // 节奏由 lastPlayAlongWakeAt 冷却（默认 5 分钟）控制，防刷屏/烧钱；仅@模式优先于活跃档，两者同开时主动跟进被压掉。
    if (!reason && !atOnlyGroup && playAlongActive(groupId)
      && message.at - (state.lastPlayAlongWakeAt || 0) >= cfg.wake.playAlongGapMs) {
      reason = { kind: 'session', seq: message.seq }
      state.lastPlayAlongWakeAt = message.at
    }
    await saveIncoming(groupId, state, message, reason, capturedBinding, cfg)
    return true
  }

  async function saveIncoming(groupId: string, state: SimSessionState, message: SimMessage, reason: SimWakeReason | null, bindingToken: string | undefined, cfg: SimRuntimeConfig): Promise<void> {
    const busy = running.has(groupId) || background.has(groupId) || liveStates.has(groupId)
    if (busy && reason) {
      state.pendingWakeReasons = pushPendingReason(state.pendingWakeReasons, reason)
      reason = null
    }
    // 任何触发命中都视为"机器人在和这个人对话"：登记对话对象并刷新延续窗口
    if (reason && message.kind === 'text') markConversationEngaged(state, message.userId, cfg.wake.continuationWindowMs)
    if (reason && ports.durableIngress) {
      const prior = state.queuedIngressWake
      const merged = mergeWakeReason(prior ?? null, reason)
      state.queuedIngressWake = merged.reason
      // Separate directed messages retain their own turn when a batch is merged.
      if (prior && isDirectAddressKind(prior.kind) && isDirectAddressKind(reason.kind)
        && state.recent.find(item => item.seq === prior.seq)?.userId !== message.userId) {
        state.pendingWakeReasons = pushPendingReason(state.pendingWakeReasons, merged.changed ? prior : reason)
      }
    }
    await store.save(groupId, state)
    if (!ports.durableIngress) await store.addKnownGroup(groupId).catch(() => logger.warn(`[仿真] 会话 ${groupId} 调度登记失败`))
    notifyWaiters(groupId)
    if (reason) await scheduleWake(groupId, reason, bindingToken, cfg, ports.durableIngress || message.kind === 'text' ? state : undefined)
  }

  async function scheduleWake(groupId: string, reason: SimWakeReason, bindingToken: string | undefined, cfg?: SimRuntimeConfig, ingressState?: SimSessionState) {
    if (stopped) return
    const config = cfg ?? runtimeConfig()
    if (running.has(groupId)) {
      const live = liveStates.get(groupId)
      if (live && live.bindingToken === bindingToken) {
        if (ports.durableIngress && sameWake(live.queuedIngressWake, reason)) return
        live.pendingWakeReasons = pushPendingReason(live.pendingWakeReasons, reason)
        await store.save(groupId, live)
      }
      return
    }
    let existing = pendingWakes.get(groupId)
    if (existing && existing.bindingToken !== bindingToken) {
      clearTimeout(existing.timer)
      pendingWakes.delete(groupId)
      existing = undefined
    }
    if (ports.durableIngress && ingressState?.queuedIngressWake) reason = ingressState.queuedIngressWake
    if (existing) {
      const merged = mergeWakeReason(existing.reason, reason)
      if (ports.durableIngress && ingressState) pendingWakes.set(groupId, { ...existing, reason })
      else if (merged.changed) pendingWakes.set(groupId, { ...existing, reason: merged.reason })
      if (!ports.durableIngress && ingressState && isDirectAddressKind(existing.reason.kind) && isDirectAddressKind(reason.kind)) {
        const previous = ingressState.recent.find(message => message.seq === existing.reason.seq)
        const incoming = ingressState.recent.find(message => message.seq === reason.seq)
        if (previous && incoming && previous.userId !== incoming.userId) {
          const deferred = merged.changed ? existing.reason : reason
          ingressState.pendingWakeReasons = pushPendingReason(ingressState.pendingWakeReasons, deferred)
          await store.save(groupId, ingressState)
        }
      }
      return
    }
    // 定时器类唤醒到点即醒（不再等合并窗），消息类按 batchWindowMs 合并可能更高优先级的触发
    const delay = TIMER_WAKE_REASONS.includes(reason.kind) ? 1_000 : config.wake.batchWindowMs
    const timer = safeSetTimeout(() => {
      // 读 map 里的最新 reason：合并窗口内高优先级触发会替换 map 条目，闭包里的旧值会把它降级（实测抓到的潜伏 bug）
      const entry = pendingWakes.get(groupId)
      pendingWakes.delete(groupId)
      if (entry) launchTurn(groupId, entry.reason, entry.bindingToken)
    }, delay, 3_600_000)
    pendingWakes.set(groupId, { timer, reason, bindingToken })
  }

  function launchTurn(groupId: string, reason: SimWakeReason, bindingToken: string | undefined): void {
    const turn = startTurn(groupId, reason, undefined, bindingToken)
    scheduledTurns.add(turn)
    void turn.catch(error => logger.error('[仿真] 调度回合失败', error)).finally(() => scheduledTurns.delete(turn))
  }

  const sameWake = (queued: SimWakeReason | undefined, reason: SimWakeReason) =>
    queued?.kind === reason.kind && queued.seq === reason.seq && queued.detail === reason.detail

  function queueWake(state: SimSessionState, reason: SimWakeReason): SimWakeReason {
    const prior = state.queuedIngressWake
    const { reason: next, changed } = mergeWakeReason(prior ?? null, reason)
    state.queuedIngressWake = next
    if (prior && !sameWake(prior, reason)) state.pendingWakeReasons = pushPendingReason(state.pendingWakeReasons, changed ? prior : reason)
    return next
  }

  async function loadWakeState(groupId: string, reason: SimWakeReason, bindingToken: string | undefined): Promise<SimSessionState | null> {
    return await queueIngress(groupId, async () => {
      const state = await store.load(groupId)
      if (stopped || state.bindingToken !== bindingToken) return null
      if (state.queuedIngressWake && !sameWake(state.queuedIngressWake, reason)) return null
      if (reason.seq !== undefined && !state.recent.some(message => message.seq === reason.seq)) return null
      liveStates.set(groupId, state)
      return state
    })
  }

  async function startTurn(groupId: string, reason: SimWakeReason, commitment?: CommitmentExecution, expectedBinding?: string): Promise<void> {
    const scopedTarget = decodeSimulationAddressKey(groupId)
    const hostUnavailable = (target = scopedTarget) => stopped || (target !== null && ports.isAccountReady?.(target.account) === false)
    let deferred = false
    if (commitment) {
      for (;;) {
        await refreshGroupState(true)
        if (hostUnavailable()) {
          commitment.result.status = 'deferred'; commitment.result.error = '宿主或原账号暂不可用'; commitment.finalized = true
          return
        }
        const bindingStillCurrent = await commitment.options.isCurrent()
        if (!groupActive(runtimeConfig(), groupId) || !bindingStillCurrent) {
          commitment.result.status = bindingStillCurrent && ports.durableIngress ? 'deferred' : 'cancelled'
          commitment.result.error = '承诺领取已失效或本群已停用'; commitment.finalized = true
          return
        }
        // Check and reserve without an await between them. Formal tasks must not
        // enter the ordinary wake merger or disappear behind an intervening turn.
        if (!running.has(groupId) && !background.has(groupId) && !ingressQueue.has(groupId)) { running.add(groupId); break }
        await sleep(50)
      }
    } else {
      if (stopped || !groupActive(runtimeConfig(), groupId)) return
      if (hostUnavailable()) return
      if (background.has(groupId)) { await scheduleWake(groupId, reason, expectedBinding, runtimeConfig()); return }
      if (running.has(groupId)) return
      running.add(groupId)
    }
    const startedAt = now()
    let toolCalls = 0
    let sends = 0
    let tokens = 0
    let confirmedActions = 0, uncertainAction = false, executionError = '', cancelled = false
    const checkCommitment = async () => {
      if (!commitment) return
      if (!commitment.started && hostUnavailable()) {
        deferred = true; throw new Error('宿主或原账号暂不可用')
      }
      if (!await commitment.options.isCurrent()) {
        cancelled = true; throw new Error('承诺执行领取已失效')
      }
      if (!commitment.started && hostUnavailable()) {
        deferred = true; throw new Error('宿主或原账号暂不可用')
      }
      if (!groupActive(runtimeConfig(), groupId)) {
        if (!commitment.started && ports.durableIngress) deferred = true
        else cancelled = true
        throw new Error('本群仿真已停用')
      }
    }
    let state: SimSessionState | null = null
    let nextWake: SimWakeReason | undefined
    let memoryTurn: Awaited<ReturnType<NonNullable<SimulationRuntimePorts['beginMemoryTurn']>>> | undefined
    const fileTurnController = new AbortController()
    fileTurnControllers.add(fileTurnController)
    const durableWake = ports.durableIngress === true && !commitment
    try {
      await store.markBusy(groupId)
      let needsSession = false
      if (commitment) {
        await refreshGroupState(true)
        state = await queueIngress(groupId, async () => {
          const snapshot = await store.load(groupId)
          const target = scopedTarget ?? targetFor(groupId, snapshot.botId || ports.getSelf().id)
          const self = selfFor(target)
          await checkCommitment()
          const binding = personaFor(target).binding
          const token = binding ? agentBindingToken(binding) : undefined
          if (self.id !== target.account.id || (snapshot.botId && snapshot.botId !== self.id) ||
              (commitment.options.botId && commitment.options.botId !== self.id) ||
              (expectedBinding !== undefined && expectedBinding !== token)) {
            cancelled = true
            return null
          }
          if (!snapshot.botId) {
            if (binding?.source !== 'configured' || !scopedTarget || !expectedBinding || commitment.options.botId !== self.id) {
              cancelled = true
              return null
            }
            // A verified scoped task can establish its own session without importing chat or a wake.
            snapshot.botId = self.id
            snapshot.personaId = agentPersonaScopeId(binding.agentId)
            snapshot.bootstrapSent = true
            needsSession = true
          }
          alignSessionBinding(snapshot, binding)
          liveStates.set(groupId, snapshot)
          return snapshot
        })
      } else {
        state = durableWake
          ? await loadWakeState(groupId, reason, expectedBinding)
          : await store.load(groupId)
      }
      if (!state) return
      const episodeConfirmedBefore = new Set(state.confirmedMessageIds ?? [])
      const cfg = runtimeConfig(groupId)
      if (!state.botId && scopedTarget && !commitment) return
      const target = scopedTarget ?? targetFor(groupId, state.botId || ports.getSelf().id)
      if (!handlesTarget(target) || ports.allowsSimulation?.(target) === false || (state.botId && target.account.id !== state.botId)) return
      const self = selfFor(target)
      if (self.id !== target.account.id) return
      const resolvedPersona = personaFor(target)
      const capturedBinding = resolvedPersona.binding ? agentBindingToken(resolvedPersona.binding) : undefined
      if ((!commitment || expectedBinding !== undefined) && capturedBinding !== expectedBinding) {
        if (commitment) cancelled = true
        return
      }
      if (resolvedPersona.binding && ports.beginMemoryTurn) {
        memoryTurn = await ports.beginMemoryTurn(resolvedPersona.binding)
      }
      if (alignSessionBinding(state, resolvedPersona.binding)) await store.save(groupId, state)
      const characterScope = characterScopeFor(target, resolvedPersona.personaId || 'default')
      const persona = createPersonaSnapshot({ botId: characterScope.botId, personaId: characterScope.personaId, persona: { ...resolvedPersona.persona, name: String(resolvedPersona.persona.name || self.name) }, systemContent: resolvedPersona.systemContent, ...(resolvedPersona.personaGuard ? { personaGuard: resolvedPersona.personaGuard } : {}), ...(resolvedPersona.binding ? {binding: resolvedPersona.binding} : {}) })
      const selfName = resolvedPersona.binding?.source === 'configured' ? persona.personaName : self.name
      let bindingCurrent = true
      const isBindingCurrent = () => {
        if (!bindingCurrent) return false
        bindingCurrent = false
        try {
          const current = personaFor(target)
          bindingCurrent = (current.personaId || 'default') === persona.personaId &&
            (current.binding ? agentBindingToken(current.binding) : undefined) === capturedBinding
        } catch { /* Invalid configuration revokes the captured binding. */ }
        return bindingCurrent
      }
      const turnState = state
      const queuedWake = durableWake ? state.queuedIngressWake : undefined
      let wakeStarted = false
      const canRunTurn = () => !stopped && groupActive(runtimeConfig(), groupId) && ports.isAccountReady?.(target.account) !== false &&
        isBindingCurrent() && memoryTurn?.isCurrent() !== false
      const wakeSourceExists = () => reason.seq === undefined || turnState.recent.some(message => message.seq === reason.seq)
      const canCallModel = () => canRunTurn() && wakeSourceExists()
      const beginWake = async <T>(start: () => T): Promise<{ result: T } | null> => {
        if (!canRunTurn() || !wakeSourceExists()) return null
        if (queuedWake && !wakeStarted) {
          if (!sameWake(turnState.queuedIngressWake, reason)) return null
          delete turnState.queuedIngressWake
          let claimed = false
          try {
            await store.save(groupId, turnState)
            claimed = canRunTurn() && wakeSourceExists()
          } finally {
            // An interruption during the save can precede every model call and
            // external action. Restore only a still-owned, still-visible wake.
            if (!claimed && !turnState.queuedIngressWake && wakeSourceExists() && isBindingCurrent()) {
              turnState.queuedIngressWake = queuedWake
              await store.save(groupId, turnState)
            }
          }
          if (!claimed) return null
        }
        wakeStarted = true
        return { result: start() }
      }
      const discardWake = () => beginWake(() => {})
      let wakeRecorded = false
      const recordWakeStart = () => {
        if (wakeRecorded) return
        wakeRecorded = true
        recordWake(turnState, now())
        turnState.lastWakeReason = reason
      }
      if (['characterGoal', 'interestUpdate', 'proactiveCheck'].includes(reason.kind) && (overridesCache?.atOnly || []).includes(groupId)) {
        if (durableWake) await discardWake()
        return
      }
      const sendOptions: SimSendOptions = {
        ...(resolvedPersona.binding ? {binding: resolvedPersona.binding} : {}),
        isCurrent: canRunTurn,
      }
      const triggerSource = reason.seq === undefined ? undefined : state.recent.find(message => message.seq === reason.seq)
      const historyProjections: AgentHistoryRecall[] = []
      const fileProjections: SimulationFileProjection[] = []
      let historyRead = false
      let ephemeralRead = false
      const toolEvent = {
        ...(isQqSimulationAddress(target) ? { group_id: Number(target.id) } : {}),
        self_id: self.id, _isAgentBindingCurrent: canCallModel,
        _ensureAgentToolCurrent: async () => {
          await ensureExecution()
          if (!canCallModel()) throw new Error('工具所属回合或消息来源已失效')
        },
        _sendAgentToolImage: (image: { readonly mime: string; readonly base64: string }, isCurrent?: () => boolean) => sendAgentToolImage(image, isCurrent),
        _sendAgentToolFile: (file: AgentFileUpload, isCurrent?: () => boolean, signal?: AbortSignal) => sendAgentToolFile(file, isCurrent, signal),
        _sendAgentToolMedia: (media: SendMediaAction['media'], isCurrent?: () => boolean, signal?: AbortSignal) => sendAgentToolMedia(media, isCurrent, signal),
        _sendAgentToolMusic: (music: AgentMusicCard, isCurrent?: () => boolean, signal?: AbortSignal) => sendAgentToolMusic(music, isCurrent, signal),
        _sendAgentToolMediaRelay: (plan: AgentMediaRelayPlan, isCurrent?: () => boolean, signal?: AbortSignal) => sendAgentToolMediaRelay(plan, isCurrent, signal),
        _agentToolPersona: Object.freeze({ name: persona.personaName, version: persona.personaVersion, aliases: Object.freeze([self.name]), ...(persona.personaGuard ? { guard: persona.personaGuard } : {}) }),
        _sendAgentToolBundle: (items: readonly MessageBundleItem[], isCurrent?: () => boolean) => sendAgentToolBundle(items, isCurrent),
        _sendAgentToolMessage: (message: AgentToolMessage, isCurrent?: () => boolean) => sendAgentToolMessage(message, isCurrent),
        ...(ports.readHistory ? { _readAgentHistory: async (input: Record<string, unknown>, guard: () => boolean, signal: AbortSignal) => {
          if (actor.kind !== 'user' || !actor.userId || !triggerSource?.messageId || triggerSource.textTruncated || triggerSource.userId !== actor.userId) throw new Error('历史查询缺少当前真人请求')
          await ensureExecution()
          if (!guard() || signal.aborted) throw new Error('历史查询工具已失效')
          historyRead = ephemeralRead = true
          const projection = await ports.readHistory!(target, input, {
            messageId: String(triggerSource.messageId), authorId: actor.userId, text: triggerSource.text, at: triggerSource.at,
            mentions: (triggerSource.mentionUserIds ?? []).map(id => ({ ...target.account, id })),
            ...(triggerSource.replyToUserId ? { replyAuthor: { ...target.account, id: triggerSource.replyToUserId } } : {}),
          }, canCallModel, signal)
          historyProjections.push(projection)
          await ensureExecution()
          if (!guard() || signal.aborted) throw new Error('历史查询工具已失效')
          return projection.text
        } } : {}),
        ...(triggerSource?.messageId && !triggerSource.textTruncated ? { _agentToolRequest: {
          messageId: String(triggerSource.messageId), text: triggerSource.text,
          mentions: (triggerSource.mentionUserIds ?? []).map(id => ({ ...target.account, id })),
          ...(triggerSource.replyToUserId ? { replyAuthor: { ...target.account, id: triggerSource.replyToUserId } } : {}),
        } satisfies AgentToolRequest } : {}),
        _readAgentToolImages: (sourceSeq: number, isCurrent?: () => boolean, signal?: AbortSignal) => readAgentToolImages(sourceSeq, isCurrent, signal),
        _readAgentFile: async (input: AgentFileRequest, isCurrent: () => boolean, signal: AbortSignal): Promise<AgentFileBytes> => {
          ephemeralRead = true
          if (!agentFiles) throw new Error('文件读取缺少当前已核验的真人请求')
          return agentFiles.readFile(input, isCurrent, signal)
        },
        _listAgentFiles: async (input: { query?: string; folderPath?: string }, isCurrent: () => boolean, signal: AbortSignal): Promise<AgentFileListing> => {
          ephemeralRead = true
          if (!agentFiles) throw new Error('文件目录读取缺少当前已核验的真人请求')
          return agentFiles.listFiles(input, isCurrent, signal)
        },
        ...(memoryTurn?.signal ? { _agentToolSignal: memoryTurn.signal } : {}),
        ...(triggerSource?.messageId !== undefined ? { _agentRequestMessageId: String(triggerSource.messageId) } : {}),
        ...(triggerSource?.text !== undefined ? { _agentUserText: triggerSource.text } : {}),
        _agentAllowsText: (_text: string) => true,
        ...(resolvedPersona.binding ? {_agentBinding: resolvedPersona.binding} : {}),
      }
      const sendText = (text: string, mentions: readonly string[] = [], replyTo?: string) =>
        sendTextMessage(groupId, self.id, text, sendOptions, mentions, replyTo)
      const selfStore = scopedStore(characterScope, resolvedPersona.binding)
      const memoryScene = { kind: 'group' as const, id: characterScope.groupId }
      const memorySceneState = await personMemory.getSceneRedactions({ identity: characterScope, scene: memoryScene })
      const attachmentSourceIds = new Set<string>()
      const triggerRevoked = Boolean(triggerSource?.messageId && await ports.isMessageRecalled?.(target, String(triggerSource.messageId)))
      const quoteRevoked = Boolean(triggerSource?.quoteSource && await ports.isMessageRecalled?.(target, triggerSource.quoteSource.messageId))
      if ((state.personMemoryInvalidatedAt || 0) !== memorySceneState.invalidatedAt) {
        state.agentHistory = []
        delete state.lastConfirmedChat
      }
      state.personMemoryInvalidatedAt = memorySceneState.invalidatedAt
      state.recent = await redactSceneMessages(characterScope, state.recent)
      state.unread = await redactSceneMessages(characterScope, state.unread)
      const lostQuoteTrigger = reason.kind === 'atMention' && needsQuoteForWake(triggerSource) &&
        !state.recent.find(message => message.seq === reason.seq)?.quoteToSelf
      if (durableWake && (triggerRevoked || lostQuoteTrigger ||
          (quoteRevoked && reason.kind === 'atMention' && needsQuoteForWake(triggerSource)))) {
        if (sameWake(state.queuedIngressWake, reason)) {
          delete state.queuedIngressWake
          await store.save(groupId, state)
        }
        return
      }
      const assertTriggerCurrent = async () => {
        const visibleQuote = triggerSource && state!.recent.find(message => message.seq === triggerSource.seq)?.quoteSource
        if ((triggerSource?.messageId && await ports.isMessageRecalled?.(target, String(triggerSource.messageId))) ||
            (visibleQuote && await ports.isMessageRecalled?.(target, visibleQuote.messageId))) {
          throw new Error('消息来源已撤回，停止使用旧上下文')
        }
        for (const id of attachmentSourceIds) {
          if (await ports.isMessageRecalled?.(target, id)) throw new Error('附件来源已撤回，停止使用旧上下文')
        }
      }
      const allowUnprovenAggregates = memorySceneState.invalidatedAt === 0
      // Summary stores have no per-line provenance. While any known person is
      // disabled in this scene, their later messages cannot safely be excluded.
      const subjectRedactions = await Promise.all((await personMemory.listSubjects(characterScope)).map(subject => personMemory.getRedactions(subject)))
      const allowRebuiltAggregates = !subjectRedactions.some(redactions => redactions.disabled || redactions.scenes.some(rule => rule.scene.kind === 'group' && rule.scene.id === memoryScene.id && rule.disabled))
      await recoverCharacter(characterScope)
      await revokeSharedDerived(groupId, characterScope)
      let activityVersion = await store.loadActivityVersion(groupId)
      if ((state.activityVersion || '') !== activityVersion) {
        state.agentHistory = []
        delete state.lastConfirmedChat
      }
      state.activityVersion = activityVersion
      let character = await characters.update(characterScope, current => expireCharacterGoals(current, now()))
      const shared = sharedFor(characterScope)
      const sharedSnapshot = await shared.contextProjection()
      const sharedFingerprint = await shared.fingerprint()
      if (state.sharedSelfFingerprint !== sharedFingerprint) {
        state.agentHistory = []
        delete state.lastConfirmedChat
      }
      state.sharedSelfFingerprint = sharedFingerprint
      const sharedIds = sharedSnapshot.map(entry => entry.id)
      const workspace = workspaceFor(characterScope)
      await workspace.pruneEvidence([...characterMemoryVisibility(character, memorySceneState.invalidatedAt).memories.map(m => `memory:${m.id}`), ...characterMemoryVisibility(character, memorySceneState.invalidatedAt).receipts.map(r => `receipt:${r.id}`)])
      const sourceMemoryIds = new Set(characterMemoryVisibility(character, memorySceneState.invalidatedAt).memories.map(memory => memory.id))
      let revisedSources = false
      if (state.personaId !== persona.personaId) {
        state.agentHistory = []
        delete state.lastConfirmedChat
      }
      state.personaId = persona.personaId
      state.botId = self.id
      let actor = resolveSimulationActor(characterScope, reason, state.recent)
      const triggerMessage = actor.kind === 'user' ? state.recent.find(message => message.seq === reason.seq) : undefined
      const anchor = reason.kind !== 'session' ? triggerMessage : undefined
      const conversationUserId = anchor?.userId
      if (actor.kind === 'autonomous' && character.paused) {
        if (durableWake) await discardWake()
        return
      }
      let focusedGoalId: string | undefined
      let focusedGoalRevision: number | undefined
      let decision: CharacterDecision['kind'] | undefined
      let turnClosed = false
      let requiresClosing = false
      // Only the synchronous final announcement can use the committed goal version.
      // This permit is never exposed to a subsequent model tool call.
      type AnnouncementPermit = { revision: number; goalRevision?: number; goalStatus?: string }
      let announcement: AnnouncementPermit | undefined
      const focusGoal = async (id: string) => {
        if (reason.kind === 'commitment') throw new Error('正式托付回合不能转为自主目标并借用托付预算')
        if ((overridesCache?.atOnly || []).includes(groupId)) throw new Error('仅被@回应模式下不执行自主目标')
        if (focusedGoalId && focusedGoalId !== id) throw new Error('一回合只能推进一个自主目标')
        if (focusedGoalId) return
        if (!characterMemoryVisibility(character, memorySceneState.invalidatedAt).goals.some(goal => goal.id === id)) throw new Error('目标的聊天来源已失效')
        const receiptId = randomUUID()
        character = await characters.update(characterScope, current => beginCharacterGoalAttempt(current, id, { id: receiptId, toolName: 'simGoalCheck' }, now()))
        const pending = character.receipts.find(item => item.id === receiptId)!
        focusedGoalId = id
        focusedGoalRevision = pending.goalRevision
        actor = { ...characterScope, kind: 'autonomous' }
        character = await characters.update(characterScope, current => recordCharacterReceipt(current, { ...pending, status: 'unknown', summary: '已进行一次目标检查，尚无外部行动结果', at: now() }, now()))
      }
      liveStates.set(groupId, state)
      rollBudgetDay(state, now())
      const verdict = await checkGroupWakeBudget(state, cfg, groupId, reason)
      if (!verdict.allowed) {
        // 预算类(回合/金额)今日不会再放行:群内提示一次后不再重试;
        // 限频类延后重试（丢弃会让 timeout 唤醒停在无定时器静默态）
        const limitText = describeBudgetLimit(verdict.reason)
        if (limitText) {
          const announceBudget = () => {
            logger.warn(`[仿真] 群 ${groupId} 唤醒被预算拦截：${verdict.reason}（今日剩余唤醒不再重试）`)
            const hasAudience = shouldAnnounceBudgetLimit(String(reason.kind), Number(turnState.lastIncomingAt) || 0, now())
            if (hasAudience && limitNoticeDue(limitNoticeAt.get(groupId) || 0, now())) {
              limitNoticeAt.set(groupId, now())
              void sendText(`（${limitText}，调用已限额，明天自动恢复喵）`)
                .then(receipt => { if (!receipt.ok) logger.warn(`[仿真] 群 ${groupId} 限额提示发送失败: ${receipt.error || ''}`) })
                .catch(() => { /* 提示失败不影响主流程 */ })
            }
          }
          if (durableWake) await beginWake(announceBudget)
          else announceBudget()
          return
        }
        if (!retryTimers.has(groupId)) {
          const timer = safeSetTimeout(() => {
            retryTimers.delete(groupId)
            launchTurn(groupId, reason, capturedBinding)
          }, 60_000)
          retryTimers.set(groupId, { timer, reason, bindingToken: capturedBinding })
        }
        return
      }
      if (reason.kind === 'characterGoal') {
        const goal = dueCharacterGoal(character, now())
        if (!goal || (reason.detail && reason.detail !== goal.id)) {
          if (durableWake) await discardWake()
          return
        }
        if (durableWake) {
          const attempt = await beginWake(() => focusGoal(goal.id).then(() => undefined, error => ({ error })))
          if (!attempt) return
          const failure = await attempt.result
          if (failure) throw failure.error
        } else await focusGoal(goal.id)
      }
      if (!durableWake && !commitment) recordWakeStart()
      const memories = normalizeMemoryList(await selfStore.loadMemories(groupId), now(), isQqSimulationAddress(target) ? undefined : isSimulationUserId)
      const followUpId = reason.kind === 'proactiveCheck' ? reason.detail : undefined
      let noteProactiveCheck: (() => void) | undefined
      if (reason.kind === 'proactiveCheck') {
        let offeredFollowUpIds: string[] | undefined
        if (followUpId) {
          const due = dueMemories(memories, now())
          if (!due.some(item => item.id === followUpId && item.proactiveSourceSeq !== undefined) || state.offeredFollowUpIds?.includes(followUpId)) {
            if (durableWake) await discardWake()
            return
          }
          const offered = new Set(state.offeredFollowUpIds)
          offeredFollowUpIds = [...due.filter(item => offered.has(item.id)).map(item => item.id), followUpId]
        }
        noteProactiveCheck = () => {
          if (offeredFollowUpIds) turnState.offeredFollowUpIds = offeredFollowUpIds
          turnState.lastProactiveCheckedSeq = turnState.seq
        }
        if (!durableWake) noteProactiveCheck()
      }

      // 唤醒预判闸：低信号唤醒（关键词/概率/延续/旁观类）先由便宜模型小上下文预判；
      // 判定不值得 → 等价 simMarkRead 静默收尾（推进水位、清未读），不进完整回合。
      // 预判不可用/异常 → 放行（fail-open，宁多花一次也不丢回复）。
      const judgeWake = ports.wakeGateJudge
      if (!followUpId && cfg.wakeGate.enabled && judgeWake && !WAKE_GATE_BYPASS_KINDS.has(reason.kind)) {
        const invokeGate = async () => {
          if (!canCallModel()) return null
          if (durableWake) { recordWakeStart(); noteProactiveCheck?.() }
          return await judgeWake({
            reason: formatWakeReason(reason),
            messages: [...turnState.unread].sort((a, b) => a.seq - b.seq).slice(-10)
              .map(m => ({ name: String(m.name || ''), text: String(m.text || '').slice(0, 80), atSelf: Boolean(m.atSelf || m.quoteToSelf) })),
          }, canCallModel)
        }
        const runGate = () => invokeGate().catch(() => null)
        const gate = durableWake ? await beginWake(runGate) : { result: runGate() }
        if (!gate) return
        const verdict = await gate.result
        if (!canCallModel()) return
        if (verdict && verdict.engage === false) {
          state.lastReadThroughSeq = state.unread.reduce((max, m) => Math.max(max, m.seq), state.lastReadThroughSeq)
          state.unread = []
          await store.save(groupId, state)
          logger.info(`[仿真] 群 ${groupId} 预判闸拦截 wake=${reason.kind}${verdict.reason ? `（${verdict.reason}）` : ''}，省一次完整回合`)
          return
        }
        if (verdict) logger.info(`[仿真] 群 ${groupId} 预判闸放行 wake=${reason.kind}${verdict.reason ? `（${verdict.reason}）` : ''}`)
      }

      const snapshot = buildWakeSnapshot(state, { limit: cfg.turn.wakeMessageLimit, maxChars: cfg.turn.wakeMaxChars, now: now(), ...(anchor ? { anchor } : {}) })
      const snapshotSeqs = snapshot.includedSeqs
      const projectedWatermark = { unread: state.unread, modelSeenSeqs: state.modelSeenSeqs, lastReadThroughSeq: state.lastReadThroughSeq }
      noteModelSeen(projectedWatermark, snapshotSeqs)
      if (!durableWake) state.modelSeenSeqs = projectedWatermark.modelSeenSeqs
      const visibleMessageSeqs = new Set(anchor ? snapshotSeqs : [...projectedWatermark.modelSeenSeqs, ...snapshotSeqs])
      // agent 长期记忆/好感度/近期动态装配（.仿真 重置不清这些）
      const affinityRaw = await selfStore.loadAffinity(groupId)
      const affinity: SimAffinityMap = Object.create(null)
      for (const [userId, value] of Object.entries(affinityRaw)) {
        const entry = value && typeof value === 'object' && !Array.isArray(value) ? value as Partial<SimAffinityEntry> : {}
        affinity[userId] = {
          score: Math.max(0, Math.min(100, Math.floor(Number(entry.score ?? 50)))),
          updatedAt: Number(entry.updatedAt) || now(),
          today: String(entry.today || ''),
          todayDelta: Math.floor(Number(entry.todayDelta) || 0),
          reasons: Array.isArray(entry.reasons) ? entry.reasons.map(String).slice(0, 8) : [],
        }
      }
      const session = state
      const recentFirst = session.recent.slice().reverse()
      const nameOf = (userId: string) => recentFirst.find(m => m.userId === userId)?.name
        || session.unread.find(m => m.userId === userId)?.name
        || memories.find(m => m.aboutUser === userId)?.content.split('说')[0]?.slice(0, 12)
        || `群友${userId.slice(-4)}`
      const addressedBy = actor.kind === 'user' ? actor.userId : undefined
      const speakers = conversationUserId ? [conversationUserId] : [...new Set([
        ...(addressedBy ? [addressedBy] : []),
        ...session.recent.slice(-10).reverse().map(m => m.userId),
      ])]
      // 委托记忆（群友托付记的事）：原文注入【群友托付的事】段（在场优先、到期高亮）
      const delegatedScope = resolvedPersona.binding?.source === 'configured' ? resolvedPersona.binding : groupId
      const delegatedEntries = normalizeDelegatedEntries(await (async () => {
        try { return await ports.loadDelegatedMemories?.(delegatedScope) ?? [] } catch { return [] }
      })(), now())
      const delegatedSection = formatDelegatedSection(anchor ? delegatedEntries.filter(entry => entry.owner === anchor.userId) : delegatedEntries, now(), speakers)
      // 独立宿主在首次合格模型调用前领取已核验的初始提示词。原 QQ 入口继续沿用 bootstrap。
      const initialPrompt = !initialPromptStore && reason.kind === 'bootstrap' ? await store.getInitPrompt(groupId) : ''
      const styleDigest = anchor || !allowUnprovenAggregates ? '' : await (async () => { try { return String((await ports.getStyleDigest?.(groupId)) || '') } catch { return '' } })()
      const userStyle = allowUnprovenAggregates ? (await store.loadUserStyle(groupId).catch(() => ({ users: {} as Record<string, string[]>, updatedAt: 0 }))).users || {} : {}
      // 在场群友的人物核心档案（跨群身份级事实，≤5 人；原始字段交给人物卡合并注入）
      const speakerIds = speakers.slice(0, 5)
      const personProfiles: Record<string, PersonProfile | undefined> = Object.create(null)
      for (const speakerId of speakerIds) {
        const profile = await selfStore.loadPersonProfile(speakerId).catch(() => undefined)
        if (profile && (profile.name || profile.interests.length || profile.taboos.length || profile.traits?.length || profile.facts?.length)) personProfiles[speakerId] = profile
      }
      let personRecall = ''
      if (anchor) {
        const notebookIds = new Set(memories.map(memory => memory.personMemoryId))
        const recalled = await personMemory.query({ identity: characterScope, subjectId: anchor.userId, viewerUserId: anchor.userId,
          scene: memoryScene, localOnly: true, query: anchor.text, limit: 16 })
        const facts = formatPersonMemoryFacts(recalled.items.filter(entry => !notebookIds.has(entry.id)).slice(0, 4))
        if (facts) personRecall = `【本群人物记忆】当前发言者的历史资料。只在与当前话题相关时参考，保留陈述的来源和确定性。\n${facts}`
      }
      const globalAffinity = await selfStore.loadGlobalAffinity(speakerIds).catch(() => ({} as Record<string, number>))
      // 生物节律+生活线注入
      const hourNow2 = new Date(now() + 8 * 3600_000).getUTCHours()
      const rhythmWin2 = cfg.rhythm.enabled ? await loadRhythmWindow(cfg, characterScope) : null
      const sleepNote = rhythmWin2 ? sleepinessNote(hourNow2, rhythmWin2) : ''
      const staleNote = staleMessageNote(state.lastIncomingAt || 0, now())
      const lifeThreadsRaw = cfg.lifeThreads.enabled ? await selfStore.loadLifeThreads().catch(() => []) : []
      const lifeThreads = normalizeLifeThreads(lifeThreadsRaw)
      // 生活线×档案兴趣连接：在追的作品恰好也是某位在场群友的爱好 → 提示共同话题（社交连接点）
      const commonTopicLines: string[] = []
      for (const thread of lifeThreads.filter(t => t.status === 'active').slice(0, 3)) {
        const sharers = speakerIds.filter(id => (personProfiles[id]?.interests || []).some(interest => interestMatchesTitle(interest, thread.title)))
        if (sharers.length) commonTopicLines.push(`《${thread.title}》：${sharers.map(nameOf).join('、')}也喜欢——你们有天然共同话题，聊到时可以自然提起`)
      }
      const lifeThreadSection = formatLifeThreads(lifeThreads, commonTopicLines)
      // 本群角色自我笔记
      const selfNotesText = formatSelfMemorySection(normalizeMemoryList(await selfStore.loadSelfMemories().catch(() => []), now()))
      // 情绪四轴（跨群全局）：回合开始投影一次——注入底色段 + 本回合更新的包络锚点共用；
      // 中性带/从未写过时段落为空串，不注入（缺席=情绪平常）
      const moodCurrent = cfg.mood.enabled ? normalizeSimMood(await selfStore.loadMood().catch(() => null), now()) : null
      const moodAnchor = projectMood(moodCurrent, now(), cfg.mood.halfLifeMs)
      const moodBox = { current: moodCurrent }
      const moodSection = formatMoodSection(moodCurrent, now(), cfg.mood.halfLifeMs)
      // 长程语义召回：未读末尾消息做查询，检索"两天情节窗之外"的相关片段（1s 预算）。
      // 失败/超时不注入内容，但必须与"检索无结果"区分开——注入未完成提示，防止模型把"没召回到"当"没发生过"。
      const focusedGoal = character.goals.find(goal => goal.id === focusedGoalId)
      const recallQuery = anchor ? '' : [focusedGoal ? `${focusedGoal.title} ${focusedGoal.nextStep}` : '', ...[...state.unread].sort((a, b) => a.seq - b.seq).slice(-6).map(m => String(m.text || '').trim())].filter(Boolean).join(' ').slice(0, 160)
      let semanticRecall = ''
      let semanticRecallIncomplete = false
      let semanticProjection: AgentSemanticMemoryRecall | undefined
      if (recallQuery && ports.readSemanticMemory) {
        try {
          semanticProjection = await ports.readSemanticMemory(target, recallQuery, canCallModel, memoryTurn?.signal,
            state.unread.flatMap(message => message.messageId == null ? [] : [String(message.messageId)]))
          semanticRecall = semanticProjection?.text ?? ''
        } catch { semanticRecallIncomplete = true }
      } else if (recallQuery && typeof ports.getSemanticRecall === 'function') {
        type RecallOutcome = { ok: boolean; value: string }
        const redactions = new Map<string, Awaited<ReturnType<typeof personMemory.getRedactions>>>()
        const filterSource = Object.assign(async (source: PersonMemorySource, text: string) => {
          if (source.scene.kind !== 'group' || source.scene.id !== personMemoryAddress(target).scene.id) return false
          let snapshot = redactions.get(source.authorId)
          if (!snapshot) { snapshot = await personMemory.getRedactions({ identity: characterScope, subjectId: source.authorId }); redactions.set(source.authorId, snapshot) }
          return !isPersonMemoryRedacted(source, text, snapshot)
        }, { refresh() { redactions.clear() } })
        const outcome = await Promise.race<RecallOutcome>([
          Promise.resolve(ports.getSemanticRecall(groupId, recallQuery, { botId: characterScope.botId, personaId: characterScope.personaId, filterSource }))
            .then((value: string) => ({ ok: true, value: String(value || '') }))
            .catch(() => ({ ok: false, value: '' })),
          new Promise<RecallOutcome>(resolve => { const timer = setTimeout(() => resolve({ ok: false, value: '' }), 1000); timer.unref?.() }),
        ])
        semanticRecall = outcome.ok ? outcome.value : ''
        semanticRecallIncomplete = !outcome.ok
      }
      const narrativeMemory = !anchor && allowRebuiltAggregates && ports.readConversationMemory
        ? await ports.readConversationMemory(target, persona, canCallModel).catch(() => ({ digest: '', episodes: '' }))
        : undefined
      const groupMemoryContext = await ports.readGroupMemory?.(target, persona,
        actor.kind === 'user' && triggerMessage?.messageId != null ? String(triggerMessage.messageId) : undefined, canCallModel).catch(() => '') ?? ''
      const assertGroupMemoryCurrent = async () => {
        for (const projection of historyProjections) if (!await projection.isCurrent()) throw new Error('显式历史来源已改变，停止使用旧上下文')
        for (const projection of fileProjections) if (!await projection.isCurrent()) throw new Error('文件资料来源已改变，停止使用旧上下文')
        if (semanticProjection?.text && !await semanticProjection.isCurrent()) throw new Error('语义记忆来源已改变，停止使用旧上下文')
        if (ports.isGroupMemoryCurrent && !await ports.isGroupMemoryCurrent(target, groupMemoryContext, actor.kind === 'user', canCallModel)) throw new Error('本群资料来源已改变，停止使用旧上下文')
      }
      const ensureModelCurrent = async () => {
        if (!canCallModel()) throw new Error('模型请求的来源或绑定已改变')
        await assertTriggerCurrent()
        await assertGroupMemoryCurrent()
        const sourceState = await characters.load(characterScope)
        if ((await personMemory.getSceneRedactions({ identity: characterScope, scene: memoryScene })).invalidatedAt !== memorySceneState.invalidatedAt ||
            await shared.fingerprint() !== sharedFingerprint ||
            [...sourceMemoryIds].some(id => !activeCharacterMemories(sourceState).some(memory => memory.id === id))) {
          throw new Error('模型请求的记忆来源已改变')
        }
        if (await store.loadActivityVersion(groupId) !== activityVersion) throw new Error('角色活动已撤销，停止模型请求')
        if (!canCallModel()) throw new Error('模型请求的来源或绑定已改变')
      }
      if (!canCallModel()) return
      const wakeInput: Parameters<typeof buildWakePrompt>[0] = {
        state, reason, ...(addressedBy ? { speakerId: addressedBy } : {}), ...(anchor ? { focusSeq: anchor.seq } : {}), snapshotText: snapshot.text, unreadTotal: snapshot.unreadTotal, now: now(), selfName,
        ...(initialPrompt ? { initialPrompt } : {}),
        memories: anchor ? memories.filter(memory => memory.aboutUser === anchor.userId) : memories,
        affinity: anchor ? (affinity[anchor.userId] ? { [anchor.userId]: affinity[anchor.userId]! } : {}) : affinity,
        speakers, nameOf,
        userCatchphrases: (userId: string) => userStyle[userId],
        ...(Object.keys(personProfiles).length ? { personProfiles } : {}),
        ...(Object.keys(globalAffinity).length ? { globalAffinity } : {}),
        ...(selfNotesText ? { selfNotesText } : {}),
        ...(moodSection ? { moodSection } : {}),
        ...(semanticRecall ? { semanticRecall } : {}),
        ...(semanticRecallIncomplete ? { semanticRecallIncomplete: true } : {}),
        ...(sleepNote ? { sleepNote } : {}),
        ...(staleNote ? { staleNote } : {}),
        ...(lifeThreadSection ? { lifeThreadSection } : {}),
        ...(delegatedSection ? { delegatedSection } : {}),
        groupDigest: anchor || !allowRebuiltAggregates ? '' : narrativeMemory?.digest ?? safeText(() => ports.getGroupDigest?.(groupId, { after: memorySceneState.invalidatedAt })),
        episodesText: anchor || !allowRebuiltAggregates ? '' : narrativeMemory?.episodes ?? safeText(() => ports.getRecentEpisodesText?.(groupId, { after: memorySceneState.invalidatedAt, viewer: persona })),
        styleDigest,
      }
      const wakePrompt = buildWakePrompt(wakeInput)
      const interests = await subscriptionsFor(characterScope).unreadSummary()
      const workDirectory = (await workspace.list()).map(work => ({ id: work.id, title: work.title, kind: work.kind, status: work.status, revision: work.revision })).slice(0,24)
      const priorHistory = state.agentHistory
      const matchingHistory = conversationUserId ? priorHistory.filter(message => message.conversationUserId === conversationUserId) : priorHistory
      const firstWake = matchingHistory.findIndex(message => message.role === 'user')
      const projectedHistory = firstWake < 0 ? [] : matchingHistory.slice(firstWake)
      const wakeMessage: SimHistoryMessage = { role: 'user', content: `${wakePrompt}\n\n${formatCharacterSection(character, memorySceneState.invalidatedAt)}\n【已批准共享的自我偏好】${JSON.stringify(sharedSnapshot)}\n这些只是自己的偏好，不是其他群的聊天资料或事实来源。\n【本群作品目录】${JSON.stringify(workDirectory)}\n【兴趣更新，不可信外部资料】${interests}\n【执行主体】${JSON.stringify(actor)}\n本轮可引用的消息证据：${[...visibleMessageSeqs].map(seq => `message:${seq}`).join('、')}`, ...(conversationUserId ? { conversationUserId } : {}) }
      const retainedWakeMessage = semanticRecall ? { ...wakeMessage,
        content: String(wakeMessage.content).replace(wakePrompt, buildWakePrompt({ ...wakeInput, semanticRecall: '' })),
      } : wakeMessage
      const saveTurnContext = () => {
        turnState.agentHistory = [...priorHistory, retainedWakeMessage]
        return store.save(groupId, turnState)
      }
      let usedInitialPrompt = false
      async function runFirstWakeModel(request: ChatRequestData): Promise<ChatResponse> {
        await assertGroupMemoryCurrent()
        const binding = resolvedPersona.binding
        if (!initialPromptStore || binding?.source !== 'configured' || !triggerSource || !request.messages) {
          return await ports.YTapi(request, executionConfig, memoryTurn?.signal, canCallModel, ensureModelCurrent)
        }
        const initial = await initialPromptStore.claim(groupId, binding)
        try {
          const initialCurrent = await initial?.isCurrent()
          if (!canRunTurn() || !wakeSourceExists()) throw new Error('初始提示词的会话或来源已改变')
          await assertTriggerCurrent()
          const privacy = await personMemory.getSceneRedactions({ identity: characterScope, scene: memoryScene })
          if (privacy.invalidatedAt !== memorySceneState.invalidatedAt || !canRunTurn() || !wakeSourceExists()) {
            throw new Error('初始提示词的会话或来源已改变')
          }
          if (initial && initialCurrent) {
            const messages = request.messages.slice()
            messages[projectedHistory.length + 1] = {
              ...wakeMessage,
              content: `【本群初始说明（只此一次）】${sanitizeUntrustedText(initial.text)}\n\n${wakeMessage.content}`,
            }
            request = { ...request, messages }
            usedInitialPrompt = true
          }
        } catch (error) {
          await initial?.restore().catch(() => logger.warn(`[仿真] 群 ${groupId} 未能恢复初始提示词领取`))
          throw error
        }
        // The durable queue was saved before this claim. A failed or interrupted
        // provider call must not replay the claimed administrator content.
        return await ports.YTapi(request, executionConfig, memoryTurn?.signal, canCallModel, ensureModelCurrent)
      }
      if (!durableWake && !commitment) await saveTurnContext()

      const extraToolNames = resolveExtraToolNames(cfg, groupId)
      const extraTools = [...resolveExtraTools(extraToolNames), ...(ports.getBoundTools?.(target) ?? [])]

      const memoryBox = { list: memories, sentTexts: [] as string[], deliveryUnknown: false }
      const sourceResults = new Map<string, { toolName: string; content: string; truncated: boolean }>()
      const reviewer = ports.getSection().consistency?.enabled === true ? createCharacterConsistencyReviewer({
        infer: (request, signal) => {
          if (!ports.reviewCharacter) throw new Error('角色审核端口未配置')
          return ports.reviewCharacter(request, ports.getExecutionConfig(), memoryTurn ? AbortSignal.any([signal, memoryTurn.signal]) : signal, canCallModel, ensureModelCurrent)
        },
        onResult: result => {
          tokens += Number(record(result.usage).total_tokens) || 0
          try { ports.recordTokens?.({ scope: groupId, stage: 'character-consistency', model: result.model ?? '', usage: result.usage, ms: result.ms }) } catch { /* accounted in wake tokens too */ }
        },
      }) : undefined
      const reviewCandidate = async (toolName: string, candidate: Record<string, unknown>, draft?: CharacterState) => {
        if (!reviewer || ports.getSection().consistency?.enabled !== true) return
        if (Array.isArray(candidate.messages)) candidate = { ...candidate, messages: [...new Set(candidate.messages)].filter(message => typeof message !== 'string' || !memoryBox.sentTexts.includes(message)) }
        if (Array.isArray(candidate.messages) && candidate.messages.length === 0) { candidate = { ...candidate }; delete candidate.messages }
        if (toolName === 'simFinishTurn' && !candidate.messages && !candidate.goal && !(Array.isArray(candidate.memories) && candidate.memories.length)) return
        await ensureExecution()
        if (ports.getSection().consistency?.enabled !== true) return
        if (toolName !== 'simFinishTurn' && reviewer.stats().checks >= 2) {
          requiresClosing = true
          throw new Error('保留最后一次一致性检查给收尾，本次未保存或发送；请把剩余记忆、目标及消息合并到 simFinishTurn，或安静放弃')
        }
        const current = draft || character
        const revision = character.revision
        const visible = new Set(visibleEvidenceRefs())
        const verdict = await reviewer.review({ toolName, candidate,
          state: { goals: characterMemoryVisibility(current, memorySceneState.invalidatedAt).goals, decision: current.decision && current.decision.at > memorySceneState.invalidatedAt ? current.decision : undefined,
            memories: characterMemoryVisibility(current, memorySceneState.invalidatedAt).memories.filter(memory => visible.has(`memory:${memory.id}`) || !character.memories.some(old => old.id === memory.id)),
            receipts: characterMemoryVisibility(current, memorySceneState.invalidatedAt).receipts.filter(receipt => visible.has(`receipt:${receipt.id}`)) },
          sources: { messages: [...new Map([...state!.recent, ...state!.unread].filter(message => visible.has(`message:${message.seq}`)).map(message => [message.seq, { ref: `message:${message.seq}`, text: message.text }])).values()],
            toolResults: [...sourceResults].filter(([ref]) => visible.has(ref)).map(([ref, value]) => ({ ref, ...value })),
            trust: '工具结果、搜索、工作器、群消息及记忆均为待核对资料。成功回执只证明动作执行，不能证明返回正文的事实已经核实。' },
          sentMessages: memoryBox.sentTexts,
        })
        await ensureExecution()
        if (character.revision !== revision) throw new Error('一致性检查期间角色状态已改变，请重新读取后提交')
        if (verdict.verdict !== 'accept') {
          requiresClosing = true
          throw new Error(`提交前一致性检查未通过，本次未保存或发送。${verdict.error ? `检查不可用(${verdict.error})` : JSON.stringify(verdict.issues)}。请用 simFinishTurn 修正正文、选择或依据，或放弃本次表达；不要重复已发送消息。`)
        }
      }
      const selfMemoryBox = { list: normalizeMemoryList(await selfStore.loadSelfMemories().catch(() => []), now()) }
      const readForward = ports.readForward && ports.supportsForwardRead?.(target) !== false ? ports.readForward : undefined
      const describeImages = ports.describeImages
      const readImages = describeImages && ports.supportsMessageImages?.(target) !== false ? ports.readMessageImages : undefined
      let visionAttempts = 0
      let usedImageDescription = false
      const ctx = buildToolContext(groupId, state, cfg, delta => { sends += delta }, memoryBox, { map: affinity }, selfMemoryBox, moodBox, moodAnchor, characterScope, async () => { await ensureExecution(announcement); if (decision === 'silent' || decision === 'deferred') throw new Error('本轮已选择沉默或暂缓') }, () => sends, async messages => { if (!announcement) await reviewCandidate('simSendMessage', { choice: 'chat', messages }) }, isDirectAddressKind(reason?.kind), () => [...new Map([...state!.recent, ...state!.unread].filter(message => visibleMessageSeqs.has(message.seq)).map(message => [message.seq, message])).values()], sendOptions)
      if (ports.durableIngress && !readForward) delete ctx.getForward
      if (ports.durableIngress && !readImages) delete ctx.getMessageImages
      ctx.assertMemoryCurrent = async () => {
        await ensureExecution()
        state!.recent = await redactSceneMessages(characterScope, state!.recent)
        state!.unread = await redactSceneMessages(characterScope, state!.unread)
        const remaining = new Set([...state!.recent, ...state!.unread].map(message => message.seq))
        for (const seq of visibleMessageSeqs) if (!remaining.has(seq)) visibleMessageSeqs.delete(seq)
        await ensureExecution()
      }
      // Projection checks intentionally use this lower-level guard. Calling
      // ensureExecution here would recursively recheck the same projection.
      const ensureFileTurnCurrent = async () => {
        if (!canCallModel()) throw new Error('文件读取所属回合或角色绑定已失效')
        await assertTriggerCurrent()
        if ((await personMemory.getSceneRedactions({ identity: characterScope, scene: memoryScene })).invalidatedAt !== memorySceneState.invalidatedAt ||
            await store.loadActivityVersion(groupId) !== activityVersion || !canCallModel()) throw new Error('文件读取来源或隐私权限已改变')
      }
      const fileWrapperCurrent = (source: SimulationMessageFileSource) => {
        const wrapper = state!.recent.find(message => message.seq === source.wrapper.seq) ?? state!.unread.find(message => message.seq === source.wrapper.seq)
        if (wrapper !== source.wrapper || String(wrapper.messageId) !== String(source.wrapper.messageId)) return false
        if (!source.quoted) return wrapper.userId === source.authorId && wrapper.at === source.occurredAt && JSON.stringify(wrapper.files ?? []) === JSON.stringify(source.files)
        const quote = wrapper.quoteSource
        return quote?.messageId === source.messageId && quote.invalidatedAt === memorySceneState.invalidatedAt &&
          quote.file?.authorId === source.authorId && quote.file.occurredAt === source.occurredAt && JSON.stringify(quote.file.files) === JSON.stringify(source.files)
      }
      const fileOriginalAllowed = async (original: IncomingMessage, messageId: string, authorId: string, occurredAt: number) => {
        if (original.messageId !== messageId || conversationAddressKey(original.conversation) !== conversationAddressKey(target) ||
            original.sender.id !== authorId || original.sender.platform !== target.account.platform || original.sender.namespace !== target.account.namespace ||
            original.occurredAt !== occurredAt || original.text.length > 4000 || await ports.isMessageRecalled?.(target, messageId)) return false
        const excerpt = original.text || '[文件]'
        const redactions = await personMemory.getRedactions({ identity: characterScope, subjectId: authorId })
        return !isPersonMemoryRedacted({ scene: memoryScene, messageId, authorId, at: occurredAt, excerpt }, excerpt, redactions)
      }
      const fileRequestTextCurrent = (wrapper: SimMessage, original: IncomingMessage) => wrapper.seq !== triggerMessage?.seq ||
        !wrapper.textTruncated && sanitizeUntrustedText(original.text.replace(/\s+/g, ' ').trim() ||
          (wrapper.atSelf ? '@你' : wrapper.atOther ? '@了某人' : '')) === wrapper.text
      const allowsFileSource = async (source: SimulationMessageFileSource, original: IncomingMessage): Promise<boolean> => {
        try {
          await ensureFileTurnCurrent()
          if (!fileWrapperCurrent(source) || !await fileOriginalAllowed(original, source.messageId, source.authorId, source.occurredAt) ||
              JSON.stringify(simulationFileMetadata(original.parts)) !== JSON.stringify(source.files) ||
              !source.quoted && !fileRequestTextCurrent(source.wrapper, original)) return false
          if (source.quoted) {
            const wrapper = await ports.readQuotedMessage?.(target, String(source.wrapper.messageId), { isCurrent: canCallModel })
            if (!wrapper || wrapper.quote?.messageId !== source.messageId || !await fileOriginalAllowed(wrapper, String(source.wrapper.messageId), source.wrapper.userId, source.wrapper.at) ||
                !fileRequestTextCurrent(source.wrapper, wrapper)) return false
          }
          await ensureFileTurnCurrent()
          return fileWrapperCurrent(source)
        } catch { return false }
      }
      const loadFileMessage = async (source: SimulationMessageFileSource): Promise<IncomingMessage | undefined> => {
        await ensureFileTurnCurrent()
        if (!fileWrapperCurrent(source) || !ports.readQuotedMessage) return undefined
        const original = await ports.readQuotedMessage(target, source.messageId, { isCurrent: canCallModel })
        return original && await allowsFileSource(source, original) ? original : undefined
      }
      const allowsRepositoryFile = async (entry: ConversationFileEntry): Promise<boolean> => {
        await ensureFileTurnCurrent()
        if (!entry.uploadedBy || entry.uploadedAt === undefined) return false
        const authorId = entry.uploadedBy.id, occurredAt = entry.uploadedAt
        const linked = [...new Map([...state!.unread, ...state!.recent].map(message => [message.seq, message])).values()]
          .filter(message => message.messageId && message.userId === authorId && message.at === occurredAt && message.files?.some(file => file.name === entry.name))
        if (linked.length === 1) {
          const wrapper = linked[0]!
          return !!await loadFileMessage({ wrapper, messageId: String(wrapper.messageId), authorId, occurredAt, files: (wrapper.files ?? []).map(({ name }) => ({ name })), quoted: false })
        }
        // A repository upload has no message ID. Do not fabricate one to pass
        // message-source validation: only uploader/time can prove the broad
        // privacy cutoffs, while old unlinked erased evidence fails closed.
        const privacy = await personMemory.getRedactions({ identity: characterScope, subjectId: authorId })
        const rule = privacy.scenes.find(rule => rule.scene.kind === memoryScene.kind && rule.scene.id === memoryScene.id)
        if (privacy.disabled || rule?.disabled || occurredAt <= privacy.forgottenBefore || occurredAt <= (rule?.forgottenBefore ?? 0)) return false
        const inScene = (key: string) => {
          try { const value = JSON.parse(key); return Array.isArray(value) && value[0] === memoryScene.kind && value[1] === memoryScene.id } catch { return true }
        }
        if (occurredAt <= memorySceneState.invalidatedAt && privacy.revokedSources.some(inScene) ||
            privacy.tombstones.some(tombstone => occurredAt <= tombstone.before && (!tombstone.sourceKey || inScene(tombstone.sourceKey)))) return false
        await ensureFileTurnCurrent()
        return true
      }
      const agentFiles = actor.kind === 'user' && actor.userId && triggerMessage?.messageId && !triggerMessage.textTruncated && triggerMessage.userId === actor.userId && ports.readQuotedMessage
        ? createSimulationAgentFiles({
          target, actorId: actor.userId, request: triggerMessage, now,
          signal: memoryTurn ? AbortSignal.any([fileTurnController.signal, memoryTurn.signal]) : fileTurnController.signal,
          messages: () => [...new Map([...state!.unread, ...state!.recent].map(message => [message.seq, message])).values()],
          isVisible: seq => visibleMessageSeqs.has(seq), isCurrent: canCallModel, ensureCurrent: ensureFileTurnCurrent,
          markEphemeral: () => { ephemeralRead = true }, registerProjection: projection => { fileProjections.push(projection) },
          loadMessage: loadFileMessage, allowsSource: allowsFileSource, allowsRepositoryFile,
          ...(ports.readMessageFile ? { readMessageFile: ports.readMessageFile } : {}),
          ...(ports.listConversationFiles ? { listConversationFiles: ports.listConversationFiles } : {}),
          ...(ports.readConversationFile ? { readConversationFile: ports.readConversationFile } : {}),
          ...(ports.readPublicFile ? { readPublicFile: ports.readPublicFile } : {}),
        }) : undefined
      const readAgentToolImages = async (seq: number, toolCurrent?: () => boolean, toolSignal?: AbortSignal): Promise<readonly MessageImage[]> => {
        const signals = [toolSignal, memoryTurn?.signal].filter((value): value is AbortSignal => !!value)
        const signal = signals.length ? AbortSignal.any(signals) : undefined
        if (!Number.isSafeInteger(seq) || seq < 1) throw new Error('请使用本轮可见的附图消息正整数序号')
        if (signal?.aborted || toolCurrent?.() === false) throw new Error('工具所属回合已失效')
        await ctx.assertMemoryCurrent?.()
        const visibleMessage = () => visibleMessageSeqs.has(seq)
          ? state!.recent.find(message => message.seq === seq) ?? state!.unread.find(message => message.seq === seq)
          : undefined
        const message = visibleMessage()
        if (!message?.messageId) throw new Error('请使用本轮可见的附图消息序号')
        const quote = message.imageCount === 0 ? message.quoteSource : undefined
        if (!message.imageCount && !quote?.image) throw new Error('这条消息没有可取的附图')
        if (!ports.readMessageImages) return []
        const messageId = String(message.messageId)
        const originalId = quote?.messageId ?? messageId
        const authorId = quote?.image?.authorId ?? message.userId
        const occurredAt = quote?.image?.occurredAt ?? message.at
        const isCurrent = () => !signal?.aborted && canRunTurn() && toolCurrent?.() !== false && visibleMessage() === message
        const ensureReadCurrent = async () => {
          await ensureExecution()
          if (!isCurrent() || await ports.isMessageRecalled?.(target, messageId) ||
              originalId !== messageId && await ports.isMessageRecalled?.(target, originalId) || !isCurrent()) {
            throw new Error('附图消息来源或工具权限已失效')
          }
        }
        await ensureReadCurrent()
        const images = await ports.readMessageImages(target, { messageId, ...(quote ? { quotedMessageId: originalId } : {}) }, {
          isCurrent,
          ...(signal ? { signal } : {}),
          async allowsSource(original) {
            if (original.messageId !== originalId || conversationAddressKey(original.conversation) !== conversationAddressKey(target) ||
                original.sender.id !== authorId || original.sender.platform !== target.account.platform ||
                original.sender.namespace !== target.account.namespace || original.occurredAt !== occurredAt) return false
            const excerpt = original.text || '[图片]'
            const redactions = await personMemory.getRedactions({ identity: characterScope, subjectId: authorId })
            if (isPersonMemoryRedacted({ scene: memoryScene, messageId: originalId, authorId, at: occurredAt, excerpt }, excerpt, redactions)) return false
            await ensureReadCurrent()
            return isCurrent()
          },
        })
        await ensureReadCurrent()
        if (!images?.length) return []
        attachmentSourceIds.add(messageId)
        attachmentSourceIds.add(originalId)
        return images.slice(0, 2)
      }
      if (readImages && describeImages) {
        ctx.getMessageImages = async seq => {
          const refused = { seq, error: '本轮无法读取这条消息的图片' }
          const visibleMessage = () => visibleMessageSeqs.has(seq)
            ? state!.recent.find(message => message.seq === seq) ?? state!.unread.find(message => message.seq === seq)
            : undefined
          await ctx.assertMemoryCurrent?.()
          const message = visibleMessage()
          if (!message?.messageId) return { seq, error: '请使用本轮可见的附图消息序号' }
          const quote = message.imageCount === 0 ? message.quoteSource : undefined
          if (!message.imageCount && !quote?.image) return { seq, error: '这条消息没有可取的附图' }
          if (visionAttempts >= 2) return { seq, error: '已达本轮看图次数上限' }
          visionAttempts++
          const isCurrent = () => canRunTurn() && visibleMessage() === message
          let images: readonly MessageImage[] | undefined
          try { images = await readAgentToolImages(seq) } catch { return refused }
          if (!images?.length || !isCurrent()) return refused
          await ensureExecution()
          await assertTriggerCurrent()
          if (!isCurrent()) return refused
          let description: string | null = null
          try {
            description = await describeImages(images.slice(0, 2), { groupId, label: `消息 ${seq} 的图片`, isCurrent,
              ...(memoryTurn ? { signal: memoryTurn.signal } : {}) })
          } catch { /* The model can ask for a text description. */ }
          await ensureExecution()
          if (!isCurrent() || !description?.trim()) return { seq, error: '图片描述暂不可用，可请群友用文字说明' }
          usedImageDescription = true
          return { seq, description: safeTruncateUnicode(sanitizeUntrustedText(description.replace(/\s+/gu, ' ').trim()), 360, '…') }
        }
      }
      if (readForward) {
        ctx.getForward = async (forwardId, seq) => {
          const refused = { lines: [], error: FORWARD_READ_ERROR }
          const message = state!.recent.find(item => item.seq === seq && visibleMessageSeqs.has(item.seq))
          if (!message?.messageId || !message.forwardId || (forwardId && message.forwardId !== forwardId)) {
            return { lines: [], error: '请使用本轮可见的合并转发消息序号' }
          }
          if (!await canReadUnattributedMemory(personMemory, characterScope, memoryScene)) {
            return { lines: [], error: '当前群的人物记忆规则限制读取合并转发' }
          }
          const messageId = String(message.messageId)
          try { await ensureExecution() } catch { return refused }
          let content: ForwardContent | undefined
          try { content = await readForward(target, { messageId, forwardId: message.forwardId }, sendOptions) } catch { return refused }
          if (!content) return refused
          const lines: string[] = []
          let partial = content.partial || content.entries.length > 50
          let chars = 2
          const compact = (text: string) => sanitizeUntrustedText(text.replace(/\s+/gu, ' ').trim())
          for (const entry of content.entries.slice(0, 50)) {
            if (memorySceneState.invalidatedAt > 0 && (!entry.occurredAt || entry.occurredAt <= memorySceneState.invalidatedAt || entry.occurredAt > message.at)) {
              partial = true
              continue
            }
            const name = safeTruncateUnicode(compact(entry.senderName || '群友'), 80, '…')
            const text = compact(entry.text) || '[无可读内容]'
            const excerpt = safeTruncateUnicode(text, 250, '…')
            const line = `${'  '.repeat(Math.min(2, Math.max(0, entry.depth)))}${name}：${excerpt}`
            chars += JSON.stringify(line).length + 1
            if (chars > 3_500) { partial = true; break }
            if (excerpt !== text) partial = true
            lines.push(line)
          }
          if (lines.length) attachmentSourceIds.add(messageId)
          return { lines, ...(partial ? { partial: true } : {}) }
        }
        ctx.forwardTextOnly = true
      }
      let proactiveSourceSeq: number | undefined
      ctx.proactiveSourceSeq = () => proactiveSourceSeq
      if (anchor) ctx.waitMessageFilter = message => message.userId === anchor.userId &&
        (message.atSelf || message.quoteToSelf || (!message.atOther && !message.replyToUserId))
      const sendMessage = ctx.sendMessage
      if (followUpId) {
        ctx.sendMessage = messages => {
          if (sends > 0 || messages.length > 1) return Promise.resolve({ ok: false, error: '社交跟进只发一句；请安静收尾或合为一条' })
          return sendMessage(messages, {})
        }
      }
      const visibleCharacterRefs = new Set([
        ...characterMemoryVisibility(character, memorySceneState.invalidatedAt).memories.slice(-12).map(memory => `memory:${memory.id}`),
        ...characterMemoryVisibility(character, memorySceneState.invalidatedAt).receipts.slice(-8).map(receipt => `receipt:${receipt.id}`),
      ])
      const visibleEvidenceRefs = () => [...new Set([
        ...[...visibleMessageSeqs].filter(seq => state!.recent.some(message => message.seq === seq) || state!.unread.some(message => message.seq === seq)).map(seq => `message:${seq}`),
        ...visibleCharacterRefs,
      ])]
      ctx.noteVisibleMessages = seqs => {
        for (const seq of seqs) visibleMessageSeqs.add(seq)
      }
      const exposeToolResult = (toolName: string, result: string) => {
        try {
          const value = record(JSON.parse(result))
          if (toolName === 'simCharacterMemory') {
            if (record(value.memory).id) visibleCharacterRefs.add(`memory:${record(value.memory).id}`)
            if (Array.isArray(value.memories)) for (const memory of value.memories) if (record(memory).id) visibleCharacterRefs.add(`memory:${record(memory).id}`)
          }
        } catch { /* plain text tool result exposes no new character records */ }
      }
      const updateCharacter = async (mutate: (state: CharacterState) => CharacterState) => {
        const previousSources = new Set(characterMemoryVisibility(character, memorySceneState.invalidatedAt).memories.map(memory => memory.id))
        character = await characters.update(characterScope, mutate)
        const currentSources = new Set(characterMemoryVisibility(character, memorySceneState.invalidatedAt).memories.map(memory => memory.id))
        if ([...previousSources].some(id => !currentSources.has(id))) {
          revisedSources = true; requiresClosing = true
          await store.invalidateActivity(groupId)
          activityVersion = await store.loadActivityVersion(groupId)
          state!.activityVersion = activityVersion
          for (const id of sourceMemoryIds) if (!currentSources.has(id)) sourceMemoryIds.delete(id)
          for (const ref of visibleCharacterRefs) if (ref.startsWith('memory:') && !currentSources.has(ref.slice(7))) visibleCharacterRefs.delete(ref)
          await workspace.pruneEvidence([...currentSources].map(id => `memory:${id}`).concat(characterMemoryVisibility(character, memorySceneState.invalidatedAt).receipts.map(receipt => `receipt:${receipt.id}`)))
        }
        return character
      }
      const characterTools = createCharacterTools({
        now, read: () => characters.load(characterScope),
        update: updateCharacter,
        visibleEvidenceRefs, selectGoal: focusGoal,
        onDecision: kind => { decision = kind }, makeId: prefix => `${prefix}-${randomUUID()}`,
        sharedSourceIds: () => sharedIds,
        memoryInvalidatedAt: () => memorySceneState.invalidatedAt,
        reviewMemory: (candidate, draft) => reviewCandidate('simCharacterMemory', candidate, draft),
      })
      const activityTools = [
        ...createCharacterWorkspaceTools({ workspace, visibleEvidenceRefs, ensureActive: () => ensureExecution(), sharedSourceIds: () => sharedIds }),
        ...createCharacterSubscriptionTools({ subscriptions: subscriptionsFor(characterScope), ensureActive: () => ensureExecution() }),
        ...createSharedSelfTools({ shared, visibleEvidenceRefs, ensureActive: () => ensureExecution() }),
        ...createCharacterWorkerTools({ ensureActive: async () => { await ensureExecution(); if (ports.characterWorkerAvailable?.() === false) throw new Error('工作器连接已停用') }, visibleEvidenceRefs,
          ...(ports.runCharacterWorker && ports.characterWorkerAvailable?.() !== false ? { run: (task: CharacterWorkerTask, signal: AbortSignal) => ports.runCharacterWorker!(task, characterScope, signal) } : {}),
        }),
      ]
      ctx.requireExplicitContinuation = true
      const simulationTools = createSimTools(ctx)
      const finishTool = createCharacterTurnTool({
        now, read: () => characters.load(characterScope),
        ...(ctx.platformUserId ? { platformUserId: ctx.platformUserId } : {}),
        update: updateCharacter,
        visibleEvidenceRefs, makeId: prefix => `${prefix}-${randomUUID()}`,
        sharedSourceIds: () => sharedIds,
        memoryInvalidatedAt: () => memorySceneState.invalidatedAt, ensureActive: () => ensureExecution(), finish: result => finishTurn(result),
        review: ({ candidate, state }) => reviewCandidate('simFinishTurn', candidate, state),
      })
      const tools = [...simulationTools, ...characterTools, finishTool, ...activityTools, ...extraTools]
      let toolSendQueue: Promise<void> = Promise.resolve()
      const queueToolSend = <T>(send: () => Promise<T>): Promise<T> => {
        const pending = toolSendQueue.then(send)
        toolSendQueue = pending.then(() => {}, () => {})
        return pending
      }
      const ensureToolSend = async () => {
        await ensureExecution()
        if (memoryBox.deliveryUnknown) throw new Error('上次发送结果未知，本回合不再发送，请核对回执')
        if (decision === 'silent' || decision === 'deferred') throw new Error('本轮已选择沉默或暂缓')
      }
      const assertToolSendAllowance = () => {
        const allowance = checkSendAllowance(state!, cfg, now(), sends, isDirectAddressKind(reason?.kind))
        if (!allowance.allowed) throw new Error(allowance.reason)
      }
      const recordToolSend = async () => {
        sends += 1
        recordSend(state!, now(), 1)
        state!.lastAiSendAt = now()
        await store.save(groupId, state!)
      }
      const sentBundles = new Set<string>()
      const sentFiles = new Set<string>()
      const sentMedia = new Set<string>()
      const sentMusic = new Set<string>()
      const sentMediaRelays = new Set<string>()
      const sendAgentToolMediaRelay = (plan: AgentMediaRelayPlan, isCurrent?: () => boolean, signal?: AbortSignal): Promise<DeliveryReceipt> => {
        const owned = validateAgentMediaRelayPlan(plan)
        return queueToolSend(async () => {
          if (isCurrent?.() === false || signal?.aborted) throw new Error('工具所属回合已失效')
          await ensureToolSend()
          if (ephemeralRead) return { state: 'failed', code: 'temporary_sources' }
          if (actor.kind !== 'user' || target.kind !== 'group') return { state: 'failed', code: 'invalid_media_relay_target' }
          const safeText = (text: string) => {
            const redacted = redactInternalStatusLeaks(sanitizeFinalReplyText(text))
            return !redacted.heavy && redacted.text === text && !looksLikeToolArguments(text)
          }
          const texts = owned.items.map(item => item.parts.flatMap(part => part.kind === 'text' ? [part.text] : []).join(''))
          if ([...texts, texts.join('\n'), ...owned.items.flatMap(item => item.parts.flatMap(part => part.kind === 'text' ? [part.text] : []))].some(text => !safeText(text))) return { state: 'failed', code: 'unsafe_media_relay_text' }
          const artifactKey = (artifact: AgentMediaArtifact) => ({ kind: artifact.kind, mime: artifact.mime, sizeBytes: artifact.sizeBytes, sha256: artifact.sha256 })
          const canonical = owned.items.map(item => {
            const parts: Record<string, unknown>[] = []
            for (const part of item.parts) {
              const last = parts.at(-1)
              if (part.kind === 'text') {
                if (last?.kind === 'text') last.text = String(last.text) + part.text
                else parts.push({ kind: 'text', text: part.text })
              } else parts.push({ kind: part.kind, artifact: artifactKey(part.artifact), ...(part.kind === 'video' && part.thumbnail ? { thumbnail: artifactKey(part.thumbnail) } : {}) })
            }
            return { parts }
          })
          const fingerprint = createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
          if (sentMediaRelays.has(fingerprint)) return { state: 'failed', code: 'duplicate_media_relay' }
          if (!ports.messageActions?.sendMediaRelay) return { state: 'failed', code: 'media_relay_unavailable' }
          assertToolSendAllowance()
          if (texts.some(Boolean)) await reviewCandidate('toolReply', { messages: texts.filter(Boolean) })
          await ensureExecution()
          const guard = () => !signal?.aborted && !ephemeralRead && sendOptions.isCurrent?.() !== false && isCurrent?.() !== false
          if (!guard()) throw new Error('工具所属回合已失效')
          let receipt: DeliveryReceipt
          try { receipt = normalizeDeliveryReceipt(await ports.messageActions.sendMediaRelay({
            version: 1, kind: 'media-relay.send', target, mode: 'forward', plan: owned,
            ...(sendOptions.binding ? { binding: sendOptions.binding } : {}),
          }, { isCurrent: guard, ...(signal ? { signal } : {}) })) }
          catch { receipt = { state: 'unknown' } }
          if (receipt.state === 'unknown') memoryBox.deliveryUnknown = true
          if (receipt.state === 'sent') {
            sentMediaRelays.add(fingerprint)
            memoryBox.sentTexts.push(...texts.filter(Boolean))
            rememberDelivery(state!, { ok: true, messageId: receipt.messageId })
            try { await recordToolSend() }
            catch { memoryBox.deliveryUnknown = true; return { state: 'unknown' } }
          }
          return receipt
        })
      }
      const sendAgentToolMusic = (music: AgentMusicCard, isCurrent?: () => boolean, signal?: AbortSignal): Promise<DeliveryReceipt> => {
        const owned = validateAgentMusicCard(music)
        return queueToolSend(async () => {
          if (isCurrent?.() === false || signal?.aborted) throw new Error('工具所属回合已失效')
          await ensureToolSend()
          if (ephemeralRead) return { state: 'failed', code: 'temporary_sources' }
          if (target.kind !== 'group') return { state: 'failed', code: 'invalid_music_target' }
          for (const value of [owned.title, owned.artist ?? '']) {
            const redacted = redactInternalStatusLeaks(sanitizeFinalReplyText(value))
            if (redacted.heavy || redacted.text.trim() !== value.trim() || looksLikeToolArguments(value)) return { state: 'failed', code: 'unsafe_music_text' }
          }
          // A refreshed vkey must not turn the same song into a second card in one turn.
          const fingerprint = createHash('sha256').update(owned.pageUrl).digest('hex')
          if (sentMusic.has(fingerprint)) return { state: 'failed', code: 'duplicate_music' }
          if (!ports.messageActions?.sendMusic) return { state: 'failed', code: 'music_delivery_unavailable' }
          assertToolSendAllowance()
          await reviewCandidate('toolReply', { messages: [[owned.title, owned.artist].filter(Boolean).join(' - ')] })
          await ensureExecution()
          const guard = () => !signal?.aborted && sendOptions.isCurrent?.() !== false && isCurrent?.() !== false
          if (!guard()) throw new Error('工具所属回合已失效')
          let receipt: DeliveryReceipt
          try { receipt = normalizeDeliveryReceipt(await ports.messageActions.sendMusic({
            version: 1, kind: 'music.send', target, music: owned,
            ...(sendOptions.binding ? { binding: sendOptions.binding } : {}),
          }, { isCurrent: guard, ...(signal ? { signal } : {}) })) }
          catch { receipt = { state: 'unknown' } }
          if (receipt.state === 'unknown') memoryBox.deliveryUnknown = true
          if (receipt.state === 'sent') {
            sentMusic.add(fingerprint)
            rememberDelivery(state!, { ok: true, messageId: receipt.messageId })
            try { await recordToolSend() }
            catch { memoryBox.deliveryUnknown = true; return { state: 'unknown' } }
          }
          return receipt
        })
      }
      const sendAgentToolMedia = (media: SendMediaAction['media'], isCurrent?: () => boolean, signal?: AbortSignal): Promise<DeliveryReceipt> => {
        const owned = validateAgentMedia(media)
        return queueToolSend(async () => {
          if (isCurrent?.() === false || signal?.aborted) throw new Error('工具所属回合已失效')
          await ensureToolSend()
          if (ephemeralRead) return { state: 'failed', code: 'temporary_sources' }
          const spoken = owned.kind === 'audio' ? owned.spokenText : undefined
          if (spoken !== undefined) {
            const redacted = redactInternalStatusLeaks(sanitizeFinalReplyText(spoken))
            if (redacted.heavy || redacted.text.trim() !== spoken.trim() || looksLikeToolArguments(spoken)) return { state: 'failed', code: 'unsafe_spoken_text' }
          }
          const fingerprint = createHash('sha256').update(owned.kind).update('\0').update(owned.mime).update('\0').update(owned.base64).digest('hex')
          if (sentMedia.has(fingerprint) || spoken && memoryBox.sentTexts.includes(spoken)) return { state: 'failed', code: 'duplicate_media' }
          if (!ports.messageActions?.sendMedia) return { state: 'failed', code: 'media_delivery_unavailable' }
          assertToolSendAllowance()
          if (spoken) await reviewCandidate('toolReply', { messages: [spoken] })
          await ensureExecution()
          const guard = () => !signal?.aborted && sendOptions.isCurrent?.() !== false && isCurrent?.() !== false
          if (!guard()) throw new Error('工具所属回合已失效')
          let receipt: DeliveryReceipt
          try { receipt = normalizeDeliveryReceipt(await ports.messageActions.sendMedia({
            version: 1, kind: 'media.send', target, media: owned,
            ...(sendOptions.binding ? { binding: sendOptions.binding } : {}),
          }, { isCurrent: guard, ...(signal ? { signal } : {}) })) }
          catch { receipt = { state: 'unknown' } }
          if (receipt.state === 'unknown') memoryBox.deliveryUnknown = true
          if (receipt.state === 'sent') {
            sentMedia.add(fingerprint)
            if (spoken) memoryBox.sentTexts.push(spoken)
            rememberDelivery(state!, { ok: true, messageId: receipt.messageId })
            try { await recordToolSend() }
            catch { memoryBox.deliveryUnknown = true; return { state: 'unknown' } }
          }
          return receipt
        })
      }
      const sendAgentToolFile = (file: AgentFileUpload, isCurrent?: () => boolean, signal?: AbortSignal): Promise<FileDeliveryReceipt> => {
        const owned = validateAgentFileUpload(file)
        return queueToolSend(async () => {
          if (isCurrent?.() === false || signal?.aborted) throw new Error('工具所属回合已失效')
          await ensureToolSend()
          if (ephemeralRead) return { state: 'failed', code: 'temporary_sources' }
          const text = agentFileUploadText(owned)
          for (const value of [owned.name, ...(text === undefined ? [] : [text])]) {
            const cleaned = sanitizeFinalReplyText(value), redacted = redactInternalStatusLeaks(cleaned)
            if (redacted.heavy || redacted.text.trim() !== value.trim() || looksLikeToolArguments(value)) return { state: 'failed', code: 'unsafe_file_text' }
          }
          const fingerprint = createHash('sha256').update(owned.name).update('\0').update(owned.mime).update('\0').update(owned.base64).digest('hex')
          if (sentFiles.has(fingerprint)) return { state: 'failed', code: 'duplicate_file' }
          if (!ports.messageActions?.sendFile) return { state: 'failed', code: 'file_delivery_unavailable' }
          assertToolSendAllowance()
          if (text !== undefined && text.trim()) await reviewCandidate('toolReply', { messages: [text] })
          await ensureExecution()
          const guard = () => !signal?.aborted && sendOptions.isCurrent?.() !== false && isCurrent?.() !== false
          if (!guard()) throw new Error('工具所属回合已失效')
          let receipt: FileDeliveryReceipt
          try { receipt = normalizeFileDeliveryReceipt(await ports.messageActions.sendFile({
            version: 1, kind: 'file.upload', target, file: owned,
            ...(sendOptions.binding ? { binding: sendOptions.binding } : {}),
          }, { isCurrent: guard, ...(signal ? { signal } : {}) })) }
          catch { receipt = { state: 'unknown' } }
          if (receipt.state === 'unknown') memoryBox.deliveryUnknown = true
          if (receipt.state === 'uploaded') {
            sentFiles.add(fingerprint)
            if (receipt.messageId) rememberDelivery(state!, { ok: true, messageId: receipt.messageId })
            try { await recordToolSend() }
            catch {
              // The platform accepted the file. A failed local budget write must
              // still fence callers that catch errors or misreport success.
              memoryBox.deliveryUnknown = true
              return { state: 'unknown' }
            }
          }
          return receipt
        })
      }
      const sentToolMessages = new Set<string>()
      const sendAgentToolMessage = (message: AgentToolMessage, isCurrent?: () => boolean): Promise<DeliveryReceipt> => {
        const owned = validateAgentToolMessage(message)
        const text = owned.text, mentions = [...(owned.mentionUserIds ?? [])]
        return queueToolSend(async () => {
          if (isCurrent?.() === false) throw new Error('工具所属回合已失效')
          await ensureToolSend()
          if (looksLikeToolArguments(text)) throw new Error('工具回复含参数内容，已拦截')
          const redacted = redactInternalStatusLeaks(sanitizeFinalReplyText(text))
          if (redacted.heavy || text.trim() && !redacted.text) throw new Error('通知内容无法安全发送')
          const cleaned = redacted.text || ' '
          const fingerprint = JSON.stringify([cleaned, [...mentions].sort()])
          if (sentToolMessages.has(fingerprint) || (redacted.text && memoryBox.sentTexts.includes(redacted.text))) return { state: 'failed', code: 'duplicate_message' }
          assertToolSendAllowance()
          if (redacted.text) await reviewCandidate('toolReply', { messages: [redacted.text] })
          await ensureExecution()
          const guard = () => sendOptions.isCurrent?.() !== false && isCurrent?.() !== false
          if (!guard()) throw new Error('工具所属回合已失效')
          let receipt: DeliveryReceipt
          try {
            const delivered = await sendTextMessage(groupId, self.id, cleaned, { ...sendOptions, isCurrent: guard }, mentions)
            receipt = delivered.unknown ? { state: 'unknown' } : delivered.ok && delivered.messageId
              ? { state: 'sent', messageId: String(delivered.messageId) } : { state: 'failed', code: 'message_delivery_failed' }
          } catch { receipt = { state: 'unknown' } }
          if (receipt.state === 'unknown') memoryBox.deliveryUnknown = true
          if (receipt.state === 'sent') {
            sentToolMessages.add(fingerprint)
            if (redacted.text) memoryBox.sentTexts.push(redacted.text)
            rememberDelivery(state!, { ok: true, messageId: receipt.messageId })
            await recordToolSend()
          }
          return receipt
        })
      }
      const coalesceBundleParts = (parts: readonly MessageBundlePart[]) => {
        const combined: MessageBundlePart[] = []
        for (const part of parts) {
          const previous = combined.at(-1)
          if (part.kind === 'text' && previous?.kind === 'text') combined[combined.length - 1] = { kind: 'text', text: previous.text + part.text }
          else combined.push(part)
        }
        return combined
      }
      const sendAgentToolBundle = (items: readonly MessageBundleItem[], isCurrent?: () => boolean): Promise<DeliveryReceipt> => {
        // Take ownership before waiting behind another send in this turn.
        const owned = validateMessageBundle(items)
        return queueToolSend(async () => {
          if (isCurrent?.() === false) throw new Error('工具所属回合已失效')
          await ensureToolSend()
          if (isCurrent?.() === false) throw new Error('工具所属回合已失效')
          const hasImages = owned.some(item => item.parts.some(part => part.kind === 'image'))
          const cleaned = validateMessageBundle(owned.map(item => {
            // QQ displays successive text segments without an inserted separator.
            // Validate that actual text, not each attacker-controlled fragment.
            const fullText = item.parts.flatMap(part => part.kind === 'text' ? [part.text] : []).join('')
            if (looksLikeToolArguments(fullText)) throw new Error('工具回复含参数内容，已拦截')
            const parts = coalesceBundleParts(item.parts).map(part => {
              if (part.kind !== 'text') return part
              if (looksLikeToolArguments(part.text)) throw new Error('工具回复含参数内容，已拦截')
              const text = sanitizeFinalReplyText(part.text)
              const redacted = redactInternalStatusLeaks(text)
              if (!text || redacted.heavy || !redacted.text) throw new Error('工具回复包含内部状态或清理后为空，已拦截')
              // A rendered card cannot be edited by the text sanitizer. Reject a
              // changed companion text rather than send pixels of its old version.
              if (hasImages && redacted.text !== part.text) throw new Error('图文内容需要清理，未发送')
              return { kind: 'text' as const, text: redacted.text }
            })
            const cleanedText = parts.flatMap(part => part.kind === 'text' ? [part.text] : []).join('')
            if (fullText && redactInternalStatusLeaks(sanitizeFinalReplyText(fullText)).text !== cleanedText) throw new Error('合并文字需要清理，未发送')
            // Preserve already-valid 4000-character segments when no content
            // changed; a temporary coalesced run may exceed the per-part cap.
            if (cleanedText === fullText) return item
            return { parts }
          }))
          const fingerprint = createHash('sha256').update(JSON.stringify(cleaned.map(item => coalesceBundleParts(item.parts)))).digest('hex')
          if (sentBundles.has(fingerprint)) return { state: 'failed', code: 'duplicate_bundle' }
          if (!ports.messageActions?.sendBundle) return { state: 'failed', code: 'bundle_delivery_unavailable' }
          const texts = cleaned.map(item => item.parts.flatMap(part => part.kind === 'text' ? [part.text] : []).join('')).filter(Boolean)
          assertToolSendAllowance()
          if (texts.length) await reviewCandidate('toolReply', { messages: texts })
          await ensureExecution()
          const guard = () => sendOptions.isCurrent?.() !== false && isCurrent?.() !== false
          if (!guard()) throw new Error('工具所属回合已失效')
          let receipt: DeliveryReceipt
          try {
            receipt = normalizeDeliveryReceipt(await ports.messageActions.sendBundle({
              version: 1, kind: 'message.bundle.send', target, items: cleaned,
              ...(sendOptions.binding ? { binding: sendOptions.binding } : {}),
            }, { isCurrent: guard }))
          } catch { receipt = { state: 'unknown' } }
          if (receipt.state === 'unknown') memoryBox.deliveryUnknown = true
          if (receipt.state === 'sent') {
            sentBundles.add(fingerprint)
            memoryBox.sentTexts.push(...texts)
            rememberDelivery(state!, { ok: true, messageId: receipt.messageId })
            await recordToolSend()
          }
          return receipt
        })
      }
      const sendAgentToolImage = (image: { readonly mime: string; readonly base64: string }, isCurrent?: () => boolean): Promise<DeliveryReceipt> => queueToolSend(async () => {
        if (isCurrent?.() === false) throw new Error('工具所属回合已失效')
        await ensureToolSend()
        if (isCurrent?.() === false) throw new Error('工具所属回合已失效')
        const validated = validateAgentToolImage(image)
        if (!ports.messageActions) return { state: 'failed', code: 'image_delivery_unavailable' }
        assertToolSendAllowance()
        await ensureExecution()
        const guard = () => sendOptions.isCurrent?.() !== false && isCurrent?.() !== false
        if (!guard()) throw new Error('工具所属回合已失效')
        let receipt: DeliveryReceipt
        try {
          receipt = normalizeDeliveryReceipt(await ports.messageActions.send({
            version: 1, kind: 'message.send', target,
            parts: [{ kind: 'image', resource: { kind: 'reference', value: `base64://${validated.base64}` } }],
            ...(sendOptions.binding ? { binding: sendOptions.binding } : {}),
          }, { isCurrent: guard }))
        } catch { receipt = { state: 'unknown' } }
        if (receipt.state === 'unknown') memoryBox.deliveryUnknown = true
        if (receipt.state === 'sent') {
          rememberDelivery(state!, { ok: true, messageId: receipt.messageId })
          await recordToolSend()
        }
        return receipt
      })
      const toolReply = (payload: unknown) => queueToolSend(async () => {
        await ensureToolSend()
        const segments = normalizeReplyPayload(payload)
        const safeSegments = segments.map(segment => {
          const item = record(segment)
          if (item.type !== 'text') return segment
          const text = String(record(item.data).text || '')
          if (looksLikeToolArguments(text)) throw new Error('工具回复含参数内容，已拦截')
          const sanitized = sanitizeFinalReplyText(text)
          if (!sanitized) throw new Error('工具回复清理后为空')
          const redacted = redactInternalStatusLeaks(sanitized)
          if (redacted.heavy) throw new Error('工具回复包含内部状态，已拦截')
          return { ...item, data: { ...record(item.data), text: redacted.text } }
        })
        const replySeen = new Set(memoryBox.sentTexts)
        let duplicatesSkipped = 0
        const transportSegments = safeSegments.filter(segment => {
          if (record(segment).type !== 'text') return true
          const text = String(record(record(segment).data).text || '')
          if (replySeen.has(text)) { duplicatesSkipped++; return false }
          replySeen.add(text); return true
        })
        const replyTexts = transportSegments.filter(segment => record(segment).type === 'text').map(segment => String(record(record(segment).data).text || ''))
        if (!transportSegments.some(segment => !['at', 'reply'].includes(String(record(segment).type)))) return { message_id: '', sent: 0, duplicatesSkipped }
        assertToolSendAllowance()
        if (replyTexts.length) await reviewCandidate('toolReply', { messages: replyTexts })
        await ensureExecution()
        let receipt
        try { receipt = await sendNativeMessage(target, transportSegments, sendOptions) }
        catch { memoryBox.deliveryUnknown = true; throw new Error('工具消息传输中断，是否送达未知，本回合不再发送') }
        if (receipt.unknown) { memoryBox.deliveryUnknown = true; throw new Error('工具消息回执未确认，是否送达未知，本回合不再发送') }
        if (!receipt.ok) throw new Error(receipt.error || '发送失败')
        memoryBox.sentTexts.push(...replyTexts)
        await recordToolSend()
        return { message_id: receipt.messageId ?? '', data: { message_id: receipt.messageId ?? '' } }
      })
      const allowedTool = (name: string) => actor.kind === 'user' || (
        !AUTONOMOUS_DENIED_SIM_TOOLS.includes(name) && (simulationTools.some(tool => tool.name === name) || characterTools.some(tool => tool.name === name) || name === finishTool.name || activityTools.some(tool => tool.name === name) ||
          (ports.isExtraToolAutonomous?.(name) !== false && (AUTONOMOUS_EXTRA_TOOLS.includes(name) ||
            (AUTONOMOUS_CREATIVE_TOOLS.includes(name) && (ports.getSection().autonomousTools || []).includes(name) && resolveExtraToolNames(runtimeConfig(), groupId).includes(name)))))
      )
      const ensureExecution = async (permit?: AnnouncementPermit) => {
        if (turnClosed && !permit) throw new Error('回合已结束，未执行')
        if (stopped) throw new Error('仿真运行时已停止')
        await refreshGroupState(true)
        await checkCommitment()
        if (!groupActive(runtimeConfig(), groupId)) throw new Error('本群仿真已关闭')
        if (!isBindingCurrent()) throw new Error('角色绑定已改变，本回合停止行动')
        if (memoryTurn?.isCurrent() === false) throw new Error('人物记忆权限已改变，本回合停止行动')
        await assertTriggerCurrent()
        await assertGroupMemoryCurrent()
        if ((await personMemory.getSceneRedactions({ identity: characterScope, scene: memoryScene })).invalidatedAt !== memorySceneState.invalidatedAt) {
          visibleMessageSeqs.clear()
          state!.recent = await redactSceneMessages(characterScope, state!.recent)
          state!.unread = await redactSceneMessages(characterScope, state!.unread)
          throw new Error('人物记忆来源已改变，停止使用旧上下文')
        }
        if (await shared.fingerprint() !== sharedFingerprint) throw new Error('共享偏好已改变，停止使用旧上下文')
        character = await characters.load(characterScope)
        if ([...sourceMemoryIds].some(id => !activeCharacterMemories(character).some(memory => memory.id === id))) throw new Error('本轮引用的记忆已被删除，停止使用旧上下文')
        if (actor.kind === 'autonomous' && (character.paused || (overridesCache?.atOnly || []).includes(groupId))) throw new Error('自主行动已暂停或仅被@回应')
        if (focusedGoalId && (overridesCache?.atOnly || []).includes(groupId)) throw new Error('本群已切为仅被@回应，自主目标暂停执行')
        if (permit && character.revision !== permit.revision) throw new Error('收尾保存后角色状态已改变，停止公告或标读')
        if (focusedGoalId) {
          const goal = character.goals.find(item => item.id === focusedGoalId)
          if (permit) {
            if (!goal || goal.revision !== permit.goalRevision || goal.status !== permit.goalStatus || ['paused', 'failed'].includes(goal.status) || (['active', 'waiting'].includes(goal.status) && goal.expiresAt <= now())) throw new Error('收尾目标已改变或到期，停止公告或标读')
          } else if (!goal || !['active', 'waiting'].includes(goal.status) || goal.expiresAt <= now() || goal.revision !== focusedGoalRevision) throw new Error('目标已暂停、取消、到期或更新，本回合停止行动')
        }
        // Last asynchronous read before the caller executes/sends: the console
        // may have revoked the work while the permission checks were pending.
        if (await store.loadActivityVersion(groupId) !== activityVersion) throw new Error('角色活动内容已被管理员撤销，停止旧回合')
        if (!isBindingCurrent()) throw new Error('角色绑定已改变，本回合停止行动')
        if (memoryTurn?.isCurrent() === false) throw new Error('人物记忆权限已改变，本回合停止行动')
      }
      const finishTurn = async (result: CharacterTurnFinishResult) => {
        turnClosed = true
        if (result.decision) decision = result.decision
        const committedGoal = result.state.goals.find(goal => goal.id === focusedGoalId)
        const permit: AnnouncementPermit = {
          revision: result.state.revision,
          ...(committedGoal ? { goalRevision: committedGoal.revision, goalStatus: committedGoal.status } : {}),
        }
        let sendStatus: 'not_requested' | 'succeeded' | 'failed' = 'not_requested'
        let readStatus: 'not_requested' | 'succeeded' | 'failed' = 'not_requested'
        let error: string | undefined
        let duplicatesSkipped = 0
        const sentBefore = sends
        const finishErrorText = (failure: unknown) => uncertainAction || memoryBox.deliveryUnknown
          ? '前序外部动作结果未知，已保存收尾状态；核实前不再发送公告'
          : safeToolErrorText('simFinishTurn', failure)
        if (result.messages) {
          sendStatus = 'failed'
          const id = randomUUID()
          let pending: CharacterReceipt | undefined
          try {
            if (uncertainAction || memoryBox.deliveryUnknown) throw new Error('前序外部动作结果未知，已保存收尾状态；核实前不再发送公告')
            await ensureExecution(permit)
            character = await characters.update(characterScope, current => {
              if (current.revision !== permit.revision) throw new Error('角色状态已改变，公告未登记')
              return recordCharacterReceipt(current, { id, toolName: 'simFinishTurn', status: 'pending', summary: '收尾状态已保存，等待最终消息发送回执', at: now() }, now())
            })
            permit.revision = character.revision
            pending = character.receipts.find(receipt => receipt.id === id)!
            announcement = permit
            const sender = simulationTools.find(tool => tool.name === 'simSendMessage')!
            const response = await runSimTool(sender, {
              continuation: 'chat', messages: result.messages,
              ...(result.replyToSeq === undefined ? {} : { replyToSeq: result.replyToSeq }),
              ...(result.atUserIds === undefined ? {} : { atUserIds: result.atUserIds }),
            }, toolEvent, actor, toolReply)
            sendStatus = classifyCharacterResult(response) === 'succeeded' ? 'succeeded' : 'failed'
            try { duplicatesSkipped = Number(record(JSON.parse(response.replace(/^error: /, ''))).duplicatesSkipped) || 0 } catch { /* error response retains its own delivery evidence */ }
            if (sendStatus === 'failed') error = response
          } catch (failure) { error = finishErrorText(failure) }
          finally { announcement = undefined }
          if (pending) {
            try {
              character = await characters.update(characterScope, current => {
                if (current.revision !== permit.revision) throw new Error('公告期间角色状态已改变，保留 pending 待核实，不覆盖新状态')
                return recordCharacterReceipt(current, { ...pending, status: sendStatus === 'succeeded' ? 'succeeded' : memoryBox.deliveryUnknown || sends > sentBefore ? 'unknown' : 'failed', summary: sendStatus === 'succeeded' ? `最终消息已确认发送 ${sends - sentBefore} 条，跳过重复 ${duplicatesSkipped} 条` : '最终消息发送未全部确认；已保存状态保留，不自动重发', at: now() }, now())
              })
              permit.revision = character.revision
            } catch (failure) {
              error = finishErrorText(failure)
              logger.warn(`[仿真] 群 ${groupId} 收尾发送最终回执未保存，禁止自动重发`)
            }
          }
        }
        if (sendStatus === 'failed') executionError = error || '最终消息未确认'
        if (memoryBox.deliveryUnknown) uncertainAction = true
        if (result.throughSeq !== undefined) {
          readStatus = 'failed'
          try {
            if (sendStatus === 'failed') throw new Error('最终消息未确认，保留未读，已保存角色状态不回滚')
            await ensureExecution(permit)
            if (!acknowledgeMessages(state!, result.throughSeq)) throw new Error('标读范围已改变，保留未读')
            await store.save(groupId, state!)
            readStatus = 'succeeded'
          } catch (failure) { error = finishErrorText(failure) }
        }
        if (error) executionError = error
        const outcome = {
          ok: true, choice: result.choice, saved: true,
          ...(result.goal ? { goal: result.goal } : {}), memories: result.memories || [],
          ...(result.decision ? { decision: result.decision } : {}),
          sendStatus, sent: sends - sentBefore, duplicatesSkipped, ...(memoryBox.deliveryUnknown ? { deliveryUnknown: true } : {}), readStatus, ...(error ? { error: error.slice(0, 500) } : {}),
        }
        if (JSON.stringify(outcome).length <= 3500) return outcome
        // Preserve a whole acknowledgement within the tool-history budget.
        // Full records remain in storage and can be read with the paged tools.
        const recordHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
        return { ...outcome,
          ...(result.goal ? { goal: { id: result.goal.id, revision: result.goal.revision, status: result.goal.status, recordHash: recordHash(result.goal) } } : {}),
          memories: (result.memories || []).map(memory => ({ id: memory.id, recordHash: recordHash(memory) })),
        }
      }
      const socialAttempts = new Set<SocialAction>()
      const judgeSocial = async (action: SocialAction, proposed: unknown) => {
        if (!triggerMessage || !ports.judgeSocialPermission || socialAttempts.has(action)) return 'unclear'
        if (action === 'follow_up' && triggerMessage.textTruncated) return 'unclear'
        socialAttempts.add(action)
        const started = now()
        const timeout = AbortSignal.timeout(12_000)
        const signal = memoryTurn ? AbortSignal.any([timeout, memoryTurn.signal]) : timeout
        try {
          const response = await ports.judgeSocialPermission(buildSocialPermissionRequest(action, triggerMessage.text, proposed), ports.getExecutionConfig(), signal, canCallModel, ensureModelCurrent)
          const usage = record(response.usage)
          tokens += Number(usage.total_tokens) || 0
          try { ports.recordTokens?.({ scope: groupId, stage: 'sim-social-permission', model: String(response.model || ''), usage, ms: now() - started }) } catch { /* aggregate still counts usage */ }
          return signal.aborted ? 'unclear' : readSocialVerdict(action, triggerMessage.text, response)
        } catch { return 'unclear' }
      }
      const executeTool = async (tool: typeof tools[number], args: Record<string, unknown>) => {
        if (turnClosed) return 'error: 回合已结束，未执行'
        const ephemeralTool = extraTools.includes(tool) && tool.agentDataPolicy === 'ephemeral'
        if (ephemeralRead) {
          // Explicit historical evidence has a revocable, per-turn grant. Do
          // not turn it (or a model paraphrase) into durable role state/actions.
          if (tool === finishTool) {
            if (args.goal !== undefined || Array.isArray(args.memories) && args.memories.length || ['schedule', 'wait', 'complete', 'abandon'].includes(String(args.choice))) return `error: 本轮${historyRead ? '历史' : '文件'}资料仅供临时查证，不能保存为记忆、目标或派生作品；请回复或安静收尾`
            args = { ...args, reason: '本轮临时资料仅用于查证' }
          } else if (!ephemeralTool && !['chatHistoryTool', 'excelWorkbookTool', 'simSendMessage', 'simGetState', 'simGetUnreadMessages', 'simGetRecentMessages', 'simGetMessageDetail', 'simMarkRead'].includes(tool.name)) {
            return `error: 本轮${historyRead ? '历史' : '文件'}资料仅供临时查证，请继续查询或回复，不保存派生状态或执行其他动作`
          }
        }
        if (requiresClosing && tool !== finishTool) return 'error: 已进入收尾阶段，仅允许 simFinishTurn，未执行'
        if (!requiresClosing && tool === finishTool && Array.isArray(args.memories) &&
          args.memories.some(memory => ['pendingEvent', 'interaction'].includes(String(record(memory).kind)))) {
          return 'error: 本群社交记忆未保存。请先单独调用 simRemember 保存 pendingEvent 或 interaction，成功后再用 simFinishTurn 收尾。'
        }
        // A failed save cannot subsequently fall through the ordinary-text sender.
        if (tool === finishTool) requiresClosing = true
        if (tool.name === 'simWorkerTask' && ports.characterWorkerAvailable?.() === false) return 'error: 工作器连接已停用'
        if (!allowedTool(tool.name)) return 'error: 自主执行主体没有此工具权限，不能借用群友身份'
        try { await ensureExecution() } catch (error) { return safeToolErrorText(tool.name, error) }
        if (tool.name === 'simRemember') {
          proactiveSourceSeq = undefined
          if (args.kind === 'pendingEvent' && args.scope !== 'self' && actor.kind === 'user' && actor.userId &&
            (args.aboutUser === undefined || String(args.aboutUser) === actor.userId)) {
            args = { ...args, aboutUser: actor.userId }
            if (args.welcomeProactiveFollowUp === true &&
              await judgeSocial('follow_up', args.content) === 'explicit_invitation' &&
              triggerMessage && state!.recent.some(message => message.seq === triggerMessage.seq)) {
              proactiveSourceSeq = triggerMessage.seq
            }
            try { await ensureExecution() } catch (error) { return safeToolErrorText(tool.name, error) }
          }
        }
        const newGoal = tool === finishTool && args.choice === 'schedule' ? args.goal : tool.name === 'simGoal' && args.action === 'create' ? args : undefined
        if (newGoal && triggerMessage && ports.judgeSocialPermission) {
          if (await judgeSocial('goal', newGoal) !== 'own_goal') {
            // Nothing has been saved. Allow a valid chat or silent close.
            if (tool === finishTool) requiresClosing = false
            return 'error: 此安排没有核实为角色自己的目标。社交问候用 simRemember；请正常聊天或安静收尾。'
          }
          try { await ensureExecution() } catch (error) { return safeToolErrorText(tool.name, error) }
        }
        if ((decision === 'silent' || decision === 'deferred') && ['simSendMessage', 'simShareVideoCard', 'simSendPoke', 'simQzoneInteract', 'sendLocalEmojiTool'].includes(tool.name)) return 'error: 本轮已选择沉默或暂缓'
        if (tool === finishTool && Object.hasOwn(args, 'throughSeq') && (typeof args.throughSeq !== 'number' || !Number.isSafeInteger(args.throughSeq) || args.throughSeq < 0 || args.throughSeq > readThroughSeq(state!))) return 'error: throughSeq 超过了实际看过的范围或不是非负整数，本次未保存'
        if (tool === finishTool && Object.hasOwn(args, 'replyToSeq') && (typeof args.replyToSeq !== 'number' || !Number.isSafeInteger(args.replyToSeq) || args.replyToSeq < 1 || ![...state!.unread, ...state!.recent].some(message => message.seq === args.replyToSeq))) return 'error: replyToSeq 不是近期消息的有效序号，本次未保存'
        const internal = tool === finishTool || characterTools.includes(tool) || ['simGetState', 'simGetUnreadMessages', 'simGetRecentMessages', 'simGetMessageDetail', 'simMarkRead', 'simWaitForMessages', 'simSetWakeConfig', 'simGetGroupMembers', 'simGetMessageImages', 'simGetForward'].includes(tool.name)
          || (['simRemember', 'simLifeThread'].includes(tool.name) && args.action === 'list')
        const activityRead = ['simWorkspace', 'simSubscription', 'simSharedSelf'].includes(tool.name) && ['list', 'read'].includes(String(args.action))
        if (uncertainAction && !internal && !activityRead) return 'error: 前序外部动作结果未知，本回合不再执行外部动作，核实前禁止重复提交或发送'
        if (extraTools.includes(tool) && (ephemeralTool || tool.name === 'excelWorkbookTool' || ports.readHistory && tool.name === 'chatHistoryTool')) {
          // File reads (including failures and directory listings) must bypass
          // durable action receipts before the tool can expose any content.
          ephemeralRead = true
          const result = await runSimTool(tool, args, toolEvent, actor, toolReply)
          try { await ensureExecution() } catch (error) { return safeToolErrorText(tool.name, error) }
          return result
        }
        if (internal) {
          const result = await runSimTool(tool, args, toolEvent, actor, toolReply)
          if (['simGetState', 'simGetUnreadMessages', 'simGetRecentMessages', 'simGetMessageDetail', 'simGetMessageImages', 'simGetForward', 'simWaitForMessages'].includes(tool.name)) {
            try { await ensureExecution() } catch (error) { return safeToolErrorText(tool.name, error) }
          }
          exposeToolResult(tool.name, result.slice(0, 4000))
          return result
        }
        const id = randomUUID()
        try {
          character = await characters.update(characterScope, current => focusedGoalId
            ? beginCharacterGoalAction(current, focusedGoalId, { id, toolName: tool.name }, now(), focusedGoalRevision)
            : recordCharacterReceipt(current, { id, toolName: tool.name, status: 'pending', summary: '等待工具回执', at: now() }, now()))
        } catch (error) { return safeToolErrorText(tool.name, error) }
        const pending = character.receipts.find(item => item.id === id)!
        // A cancellation arriving while persistence was pending must be observed before the external call.
        try { await ensureExecution() } catch (error) {
          character = await characters.update(characterScope, current => recordCharacterReceipt(current, { ...pending, status: 'failed', summary: '执行前已取消或授权变化，未调用工具', at: now() }, now()))
          return safeToolErrorText(tool.name, error)
        }
        let reported: 'succeeded' | 'failed' | undefined
        const alreadyUnknown = memoryBox.deliveryUnknown
        let result = await runSimTool(tool, args, toolEvent, actor, toolReply, status => { reported = status }, tool.name === 'simWorkerTask' ? id : undefined)
        let status = memoryBox.deliveryUnknown && !alreadyUnknown ? 'unknown' : reported ?? classifyCharacterResult(result)
        if (status === 'unknown') uncertainAction = true
        if (status === 'failed') executionError = '工具执行失败，承诺未完整兑现'
        if (status === 'succeeded' && (extraTools.includes(tool) || tool.name === 'simWorkerTask' || (tool.name === 'simWorkspace' && ['write', 'restore'].includes(String(args.action))))) confirmedActions++
        if (tool.name === 'simWorkerTask' && status === 'succeeded') {
          try {
            const value = record(JSON.parse(result)), artifact = record(value.artifact)
            if (typeof artifact.content === 'string' && typeof artifact.title === 'string') {
              await ensureExecution()
              const work = await workspace.write({ title: artifact.title.slice(0,120), kind: 'research', content: artifact.content, evidenceRefs: [`receipt:${id}`], ...(sharedIds.length ? {sharedSources: sharedIds} : {}) })
              result = formatSavedCharacterWorkResult(String(value.summary || ''), id, work, artifact.content)
            }
          } catch {
            uncertainAction = true
            status = 'unknown'
            executionError = '工作器已执行，但作品未能保存'
            result = JSON.stringify({ status, summary: '工作器返回成功，但作品未能保存，请核对回执后处理。' })
          }
        }
        const summary = ephemeralRead ? `${tool.name}: ${status}（临时资料正文不留存）` : redactInternalStatusLeaks(result).text.slice(0, 500) || `${tool.name}: ${status}`
        const receipt: CharacterReceipt = { ...pending, status, summary, at: now() }
        // Finalize once, after worker artifacts are saved. A lost write leaves
        // pending for unknown recovery; an immutable success must not precede it.
        character = await characters.update(characterScope, current => recordCharacterReceipt(current, receipt, now()))
        if (status === 'unknown' && focusedGoalId && !(ports.isExtraToolAutonomous?.(tool.name) !== false && AUTONOMOUS_EXTRA_TOOLS.includes(tool.name))) {
          character = await characters.update(characterScope, current => {
            const goal = current.goals.find(item => item.id === focusedGoalId)
            return goal && ['active', 'waiting'].includes(goal.status)
              ? transitionCharacterGoal(current, goal.id, 'paused', { now: now(), lastOutcome: '外部动作结果未知，暂停以免重复副作用；核对后由管理员恢复' }) : current
          })
        }
        visibleCharacterRefs.add(`receipt:${id}`)
        if (!ephemeralRead) sourceResults.set(`receipt:${id}`, { toolName: tool.name, content: result.slice(0, 8000), truncated: result.length > 8000 })
        return `${result}\n【运行时行动回执】${JSON.stringify({ evidenceRef: `receipt:${id}`, status, goalId: focusedGoalId })}`
      }
      const executionConfig = ports.getExecutionConfig()
      const providerConfig = record(executionConfig) as Parameters<typeof buildChatRequestData>[0]
      const systemPrompt = buildSimSystemPrompt({ persona: persona.persona, systemContent: persona.systemContent, selfName, hasExtraTools: extraTools.length > 0, extraToolNames, hasEmojiTool: extraToolNames.includes('sendLocalEmojiTool'), hasMoodTool: cfg.mood.enabled, availableToolNames: tools.filter(tool => allowedTool(tool.name)).map(tool => tool.name) })

      const history: SimHistoryMessage[] = [...projectedHistory, wakeMessage, ...(groupMemoryContext ? [{ role: 'user' as const, content: groupMemoryContext }] : [])]
      const firstCurrentMessage = projectedHistory.length
      const appendToolReply = (toolCallId: string, name: string, content: string) => {
        history.push({ role: 'tool', tool_call_id: toolCallId, name, content })
        if (ports.recordToolResult && !ephemeralRead) {
          const failed = () => logger.warn(`[仿真] 群 ${groupId} 工具回复观察失败，不影响执行`)
          try {
            // Give observers an immutable copy, and isolate an accidental async rejection too.
            void Promise.resolve(ports.recordToolResult(Object.freeze({ toolCallId, name, content }))).catch(failed)
          } catch { failed() }
        }
      }
      type RawToolCall = NonNullable<SimHistoryMessage['tool_calls']>[number]
      let rounds = 0
      // 用户对话/正式托付的未外发文本兜底：自主回合的最终文本只留在内部历史。
      let nudgedForUnsent = false
      while (rounds < cfg.turn.maxToolRounds) {
        rounds += 1
        const closing = requiresClosing || rounds > cfg.turn.maxToolRounds - 2
        const roundTools = closing ? [finishTool] : tools.filter(tool => allowedTool(tool.name))
        const context = buildCharacterTurnContext({ phase: closing ? 'closing' : 'acting', remainingToolRounds: cfg.turn.maxToolRounds - rounds + 1, ...(focusedGoalId ? { focusedGoalId } : {}), visibleEvidenceRefs: visibleEvidenceRefs() }) +
          (anchor ? `\n当前只回应 #${anchor.seq} 的话题；同一人的前文也仅在有关时用。throughSeq 当前上限是 ${readThroughSeq(durableWake && rounds === 1 ? projectedWatermark : state)}，可省略。` : '') +
          (reviewer ? `\n本轮剩余提交检查次数：${Math.max(0, 3 - reviewer.stats().checks)}。将需要保存的观点、目标和最终消息合并进 simFinishTurn；检查退回后自行修正或安静放弃，检查提示不发到群里。` : '')
        const requestHistory = history.map(({ conversationUserId: _user, ...message }) => message)
        const currentContext = personRecall ? `${personRecall}\n\n${context}` : context
        const requestData = buildChatRequestData(providerConfig, [{ role: 'system', content: systemPrompt }, ...requestHistory, { role: 'user', content: currentContext }], simToolsAsFunctions(roundTools), closing ? 'required' : 'auto')
        if (closing && (!requestData.tools?.length || !requestData.tool_choice)) {
          logger.warn(`[仿真] 群 ${groupId} 模型配置未提供收尾工具，停止本轮`)
          if (durableWake && rounds === 1) { await discardWake(); return }
          break
        }
        let response: ChatResponse
        try {
          await checkCommitment()
          await assertTriggerCurrent()
          await assertGroupMemoryCurrent()
          if (semanticProjection?.text && !await semanticProjection.isCurrent()) throw new Error('语义记忆来源已改变，停止使用旧上下文')
          // Goal completion can legitimately lead to a final model round. The
          // privacy guard is independent of those action/version permissions.
          if ((await personMemory.getSceneRedactions({ identity: characterScope, scene: memoryScene })).invalidatedAt !== memorySceneState.invalidatedAt) {
            visibleMessageSeqs.clear()
            throw new Error('人物记忆来源已改变，停止使用旧上下文')
          }
          if (durableWake && rounds === 1) {
            const model = await beginWake(async () => {
              recordWakeStart()
              noteProactiveCheck?.()
              noteModelSeen(turnState, snapshotSeqs)
              const write = saveTurnContext().catch(() => logger.warn(`[仿真] 群 ${groupId} 回合上下文保存失败`))
              try { return { response: await runFirstWakeModel(requestData) } }
              catch (error) { return { error } }
              finally { await write }
            })
            if (!model) return
            const result = await model.result
            if ('error' in result) throw result.error
            response = result.response
          } else if (commitment && !commitment.started) {
            await checkCommitment()
            if (needsSession) await store.addKnownGroup(groupId)
            if (!canRunTurn()) {
              cancelled = true; throw new Error('承诺绑定或执行环境已改变')
            }
            if (commitment.options.beforeExecution && !await commitment.options.beforeExecution()) {
              cancelled = true; throw new Error('承诺执行领取已失效')
            }
            commitment.started = true
            if (!canRunTurn()) throw new Error('承诺开始后执行环境已改变')
            recordWakeStart()
            noteModelSeen(turnState, snapshotSeqs)
            const write = saveTurnContext().catch(() => logger.warn(`[仿真] 群 ${groupId} 回合上下文保存失败`))
            try { response = await ports.YTapi(requestData, executionConfig, memoryTurn?.signal, canCallModel, ensureModelCurrent) }
            finally { await write }
          } else {
            if (!canRunTurn()) throw new Error('角色绑定或运行状态已改变，本回合停止行动')
            response = await ports.YTapi(requestData, executionConfig, memoryTurn?.signal, canCallModel, ensureModelCurrent)
          }
        } catch (error) {
          executionError = error instanceof Error ? error.message : '模型调用失败'
          logger.error(`[仿真] 群 ${groupId} 模型调用失败`, error)
          break
        }
        if (response.error) executionError = '模型返回错误'
        tokens += Number(record(response.usage).total_tokens) || 0
        try {
          ports.recordTokens?.({ scope: groupId, stage: 'sim', model: String((response as { model?: unknown }).model || ''), usage: record(response.usage), ms: 0 })
        } catch { /* 账本不可用不影响回合 */ }
        const message = { ...record(record((response as { choices?: { message?: unknown }[] }).choices?.[0])?.message) }
        const safeModelData = (value: unknown) => {
          try { return ports.allowsToolInput?.(JSON.stringify(value) ?? '') !== false } catch { return false }
        }
        if (!safeModelData(message.content)) message.content = ''
        const rejectedToolCalls = new Set<RawToolCall>()
        const toolCallsRaw: RawToolCall[] = (Array.isArray(message.tool_calls) ? message.tool_calls as RawToolCall[] : []).map(call => {
          if (safeModelData(call)) return call
          const raw = record(call), fn = record(raw.function)
          const blocked: RawToolCall = {
            id: typeof raw.id === 'string' && safeModelData(raw.id) ? raw.id : randomUUID(),
            type: 'function',
            function: { name: typeof fn.name === 'string' && safeModelData(fn.name) ? fn.name : 'blockedTool', arguments: '{}' },
          }
          rejectedToolCalls.add(blocked)
          return blocked
        })
        if (!toolCallsRaw.length) {
          const text = String(message.content || '').trim()
          // 先保留模型最终文本；自主回合是否发言必须由显式发送工具决定。
          if (text) history.push({ role: 'assistant', content: text })
          if (closing || actor.kind === 'autonomous') {
            if (text) logger.info(`[仿真] 群 ${groupId} 自主回合最终文本仅保留内部历史（${text.length} 字），结束回合`)
            break
          }
          // 兜底：写了像"要说的话"的文本但本回合一条都没发过 → 提醒一次（模型惯性问题，实测高发）。
          // 沉默声明（「旁听，结束回合。」「无需发送，结束回合。」）除外：那是模型在宣布不说话，
          // 提醒/直发都会把元话术漏进群里——按其意愿安静结束。
          if (!decision && text.length >= 6 && sends === 0 && !/^\[(?:不发了|SILENT|沉默)\]$/.test(text) && !isSilentDeclaration(text)) {
            if (!nudgedForUnsent) {
              nudgedForUnsent = true
              logger.info(`[仿真] 群 ${groupId} 检测到未外发文本（${text.length} 字，本回合 0 发送），已提醒模型用 simSendMessage 发出`)
              history.push({ role: 'user', content: '【系统提醒】你刚才写的这段话群友看不到——本模式下只有 simSendMessage 发出的内容才会出现在群里，群里刚才只能看到你发的表情/动作。如果那段话就是你想说的，现在用 simSendMessage 原样（或更口语化、可拆几条）发出去；如果改变主意不想说了，从此不要再输出任何文字——「无需发送」「结束回合」「已静默结束」「不是对我说的」「(已经决定不说话)」这类说明不要写，括号里的状态标注也一样不行，直接停下即可。' })
              continue
            }
            // 提醒过一次还是把话写在文本里(实测高发:连续多轮 6 字文本 0 发送,群里看着就是已读不回)——
            // 直接替它发出去。内容照原样,不走模型再加工,避免又一轮哑火。
            // 最后防线：提醒后还输出含元话术的文本，按沉默处理不直发——漏发可以下轮补，误发进群里收不回。
            // ①词表拦截（子串级）；②形状拦截（2026-11-09 实拍「(已经决定不说话，直接停。)」漏网后新增）：
            //   整条被括号/引号包裹的"状态标注"一律不直发——词表追不上模型造句，形状是稳定的；
            //   真想发言写裸文本，括号动作（（笑））远短于 6 字门槛。
            if (mentionsSilenceVocabulary(text) || isWrappedAnnotation(text)) {
              logger.info(`[仿真] 群 ${groupId} 提醒后文本仍含元话术或为括号标注（${text.slice(0, 24)}），按沉默处理不直发`)
            } else {
              logger.info(`[仿真] 群 ${groupId} 提醒后仍未发送，兜底直发 ${text.length} 字`)
              try {
                const sender = simulationTools.find(tool => tool.name === 'simSendMessage')!
                const result = await executeTool(sender, { continuation: 'chat', messages: [text.slice(0, cfg.turn.messageTextMaxChars)] })
                history.push({ role: 'user', content: classifyCharacterResult(result) === 'succeeded' ? '【系统】已替你把上面那段话发出去了。以后想说的话必须自己调 simSendMessage。' : `【系统】这段文本未确认发送：${result.slice(0, 1000)}` })
              } catch (error) {
                logger.warn(`[仿真] 群 ${groupId} 兜底直发失败: ${error instanceof Error ? error.message : String(error)}`)
              }
            }
          } else if (text.length >= 6 && sends === 0) {
            logger.info(`[仿真] 群 ${groupId} 模型以沉默声明收尾（${text.slice(0, 24)}），按其意愿安静结束回合`)
          }
          break
        }
        history.push({ role: 'assistant', content: String(message.content || ''), tool_calls: toolCallsRaw })
        for (const call of toolCallsRaw) {
          toolCalls += 1
          const callRecord = record(call)
          const fn = record(callRecord.function)
          const name = String(fn.name || '')
          const tool = tools.find(t => t.name === name)
          let resultText: string
          if (turnClosed) {
            resultText = 'error: 回合已结束，未执行'
          } else if (rejectedToolCalls.has(call)) {
            resultText = 'error: 工具参数包含宿主禁止外发的内容，未执行'
          } else if (closing && name !== finishTool.name) {
            resultText = 'error: 当前仅允许 simFinishTurn 收尾，未执行'
          } else if (!tool) {
            resultText = `error: 未知工具 ${name}`
          } else {
            let args: Record<string, unknown>
            try { args = record(JSON.parse(String(fn.arguments || '{}'))) } catch { args = {} }
            const textOutsideTool = typeof message.content === 'string' && message.content.trim()
            const missingChatMessage = tool === finishTool && args.choice === 'chat' && actor.kind === 'user' &&
              isDirectAddressKind(reason.kind) && sends === 0 && toolCallsRaw.length === 1 &&
              (!Array.isArray(args.messages) || args.messages.length === 0) &&
              textOutsideTool && !isSilentDeclaration(textOutsideTool)
            if (missingChatMessage && !nudgedForUnsent && rounds < cfg.turn.maxToolRounds) {
              nudgedForUnsent = true
              resultText = 'error: 回复正文写在工具参数外，群友看不到，且本次没有提交。请把想发送的正文写进 simFinishTurn 的 messages 再提交；选择安静收尾时无需发送。'
            } else if (name === 'sendLocalEmojiTool') {
              // 仿真回合表情冷却：跨回合短冷却防刷屏（与主链路 postSendCooldownMs 同参）
              const cooldownMs = safeNumber(() => ports.getEmojiCooldownMs?.()) || 90_000
              const lastAt = emojiLastSentAt.get(groupId) || 0
              if (now() - lastAt < cooldownMs) {
                const waitSec = Math.ceil((cooldownMs - (now() - lastAt)) / 1000)
                resultText = `error: 表情包冷却中（还要 ${waitSec} 秒）。请直接用文字回应，本回合不要再发表情。`
              } else {
                resultText = await executeTool(tool, args)
                if (!(typeof resultText === 'string' && resultText.startsWith('error:'))) emojiLastSentAt.set(groupId, now())
              }
            } else {
              resultText = await executeTool(tool, args)
            }
          }
          // simGetMessageImages 的结果带回图片：主模型多为纯文本(实测 glm-5.3 收 image_url 直接 400，
          // 且带图历史会持久化毒化后续每个回合)。图片改经视觉侧模型转成文字描述注入，主模型保持纯文本请求。
          if (((name === 'simGetMessageImages' && !readImages) || name === 'simGetForward') && !resultText.startsWith('error:')) {
            const images = parseSimImages(resultText, name === 'simGetForward' ? 3 : 2)
            if (images.length) {
              let label = '【转发里的图片】（对应转发记录里的 [图片#N] 编号）'
              if (name === 'simGetMessageImages') {
                let seqLabel = ''
                try { seqLabel = String(record(JSON.parse(resultText)).seq ?? '') } catch { /* 忽略 */ }
                label = `【消息 ${seqLabel} 的图片】`
              }
              let described = ''
              try {
                await ensureExecution()
                if (describeImages && canCallModel()) {
                  const description = await describeImages(images, { groupId, label, isCurrent: canCallModel,
                    ...(memoryTurn ? { signal: memoryTurn.signal } : {}) })
                  await ensureExecution()
                  if (canCallModel() && description) {
                    described = description
                    usedImageDescription = true
                  }
                }
              } catch { /* A revoked or unavailable image description never enters history. */ }
              appendToolReply(String(callRecord.id || ''), name, `已获取 ${images.length} 张图片，视觉侧模型的描述见下一条消息。`)
              history.push({ role: 'user', content: `${label}\n【视觉模型描述】${described || '（图片描述暂不可用，可请群友用文字说明图片内容）'}` })
              continue
            }
          }
          appendToolReply(String(callRecord.id || ''), name, resultText.slice(0, ephemeralRead ? 32_000 : 4000))
          if (resultText.startsWith('error:')) executionError = '回合包含未完成的工具操作'
        }
        if (turnClosed) break
      }

      recordWakeTokens(state, tokens)
      const latestCharacter = await characters.load(characterScope)
      const attachmentRevoked = attachmentSourceIds.size > 0 &&
        (await Promise.all([...attachmentSourceIds].map(id => ports.isMessageRecalled?.(target, id)))).some(Boolean)
      const semanticRevoked = semanticProjection?.text && !await semanticProjection.isCurrent()
      const historyRevoked = !(await Promise.all(historyProjections.map(projection => projection.isCurrent()))).every(Boolean)
      const filesRevoked = !(await Promise.all(fileProjections.map(projection => projection.isCurrent()))).every(Boolean)
      const removedSource = attachmentRevoked || semanticRevoked || historyRevoked || filesRevoked || memoryTurn?.isCurrent() === false ||
        (await personMemory.getSceneRedactions({ identity: characterScope, scene: memoryScene })).invalidatedAt !== memorySceneState.invalidatedAt || revisedSources || [...sourceMemoryIds].some(id => !activeCharacterMemories(latestCharacter).some(memory => memory.id === id)) || await store.loadActivityVersion(groupId) !== activityVersion || await shared.fingerprint() !== sharedFingerprint || !isBindingCurrent()
      // Intermediate model output may echo ephemeral image or initial prompt material.
      const thisTurn = (semanticRecall || ephemeralRead ? [retainedWakeMessage] : usedImageDescription || usedInitialPrompt || groupMemoryContext ? [wakeMessage] : history.slice(firstCurrentMessage)).map(message => {
        const retained = readForward && message.role === 'tool' && message.name === 'simGetForward'
          ? { ...message, content: '本轮请求查看合并转发，正文需按原消息重新读取' } : message
        return conversationUserId ? { ...retained, conversationUserId } : retained
      })
      state.agentHistory = removedSource ? [] : trimAgentHistory([...priorHistory, ...thisTurn], cfg.turn.historyMaxMessages, cfg.turn.historyMaxChars)
      if (removedSource) delete state.lastConfirmedChat
      if (groupMemoryContext || semanticRecall || ephemeralRead) delete state.lastConfirmedChat
      if (sends > 0 && !removedSource && !groupMemoryContext && !semanticRecall && !ephemeralRead && actor.kind === 'user' && actor.userId && memoryBox.sentTexts.length) {
        state.lastConfirmedChat = { at: now(), userId: actor.userId, text: memoryBox.sentTexts.slice(-2).join('\n').slice(-500) }
      }
      if (sends > 0 && isBindingCurrent()) state.nextReplyCheckAt = now() + cfg.wake.replyCheckMs
      // 仿真群不走主链路，情节记忆在这里补记：让"这两天做过什么"持续有料
      if (sends > 0 && !removedSource && !semanticRecall && !ephemeralRead) try { await ports.recordGroupReply?.(target, canCallModel) } catch { /* confirmed sends remain authoritative */ }
      if (sends > 0 && !removedSource && !groupMemoryContext && !semanticRecall && !ephemeralRead) {
        try {
          const trigger = actor.kind === 'user' ? state.recent.find(message => message.seq === reason.seq) : undefined
          const replyText = memoryBox.sentTexts.slice(0, 2).join(' / ').slice(0, 200)
          if (replyText) {
            await ports.recordEpisode?.({
              groupId,
              ...(trigger?.userId ? { userId: trigger.userId, userName: trigger.name } : {}),
              summary: trigger ? `${trigger.name}说：${trigger.text}`.slice(0, 120) : `${actor.kind === 'commitment' ? '履行托付' : '主动行动'}（${reason.kind}${focusedGoalId ? `，目标 ${focusedGoalId}` : ''}）`,
              reply: replyText,
              source: {botId: persona.botId, personaId: persona.personaId, personaVersion: persona.personaVersion, personaName: persona.personaName},
              ...(resolvedPersona.binding ? { binding: resolvedPersona.binding } : {}), at: now(),
              messageIds: [...new Set(state.recent.flatMap(message => message.messageId !== null ? [String(message.messageId)] : []))],
              replyIds: (state.confirmedMessageIds ?? []).filter(id => !episodeConfirmedBefore.has(id)),
              isCurrent: canCallModel,
            })
          }
        } catch { /* 情节补记失败不影响回合 */ }
      }
      // 已在本回合展示的普通触发可消费。其他人的点名仍需独立回应，即使用户查过那条消息。
      const replay = (isBindingCurrent() ? state.pendingWakeReasons : []).filter(pending =>
        pending.seq !== reason.seq || pending.kind !== reason.kind).filter(pending =>
        (isDirectAddressKind(pending.kind) && state!.recent.some(message => message.seq === pending.seq)) ||
        messageReasonStillPending(pending, state!.unread))
      const [next, ...remaining] = replay
      state.pendingWakeReasons = remaining
      nextWake = next
      if (ports.durableIngress && (next || state.queuedIngressWake)) {
        if (next) nextWake = queueWake(state, next)
        else nextWake = state.queuedIngressWake
      }
      if (!needsSession || commitment?.started) await store.save(groupId, state)
      logger.info(`[仿真] 群 ${groupId} 回合完成 wake=${reason.kind} rounds=${rounds} toolCalls=${toolCalls} sends=${sends} tokens=${tokens} ms=${now() - startedAt}`)
      if (memoryBox.deliveryUnknown) uncertainAction = true
    } catch (error) {
      executionError = error instanceof Error ? error.message : '承诺回合异常'
      logger.error(`[仿真] 群 ${groupId} 回合异常`, error)
    } finally {
      fileTurnController.abort()
      fileTurnControllers.delete(fileTurnController)
      memoryTurn?.release()
      if (commitment) {
        const effects = sends + confirmedActions
        commitment.result.sent = sends; commitment.result.actions = confirmedActions
        commitment.result.status = uncertainAction || (effects > 0 && (executionError || cancelled)) || (commitment.started && stopped && effects === 0)
          ? 'unknown' : deferred ? 'deferred' : cancelled ? 'cancelled' : executionError ? 'failed' : effects > 0 ? 'succeeded' : 'failed'
        if (commitment.result.status === 'succeeded') delete commitment.result.error
        else commitment.result.error = executionError || (uncertainAction ? '存在未确认的外部操作，不自动重试' : '回合未确认任何执行或发送')
        commitment.finalized = true
      }
      running.delete(groupId)
      liveStates.delete(groupId)
      notifyWaiters(groupId)
      void store.clearBusy(groupId).catch(() => logger.warn(`[仿真] 群 ${groupId} 清理忙碌标记失败`))
    }
    if (nextWake && !stopped) await scheduleWake(groupId, nextWake, state?.bindingToken)
  }

  async function sendNativeMessage(target: ConversationAddress, segments: unknown[], options?: SimSendOptions): Promise<SimTransportReceipt> {
    if (!isQqSimulationAddress(target) || !ports.sendGroupMessage) return { ok: false, error: '当前会话不支持 QQ 原生消息' }
    return await ports.sendGroupMessage(target.id, segments, target.account.id, options)
  }

  async function sendTextMessage(groupId: string, botId: string, text: string, options?: SimSendOptions, mentions: readonly string[] = [], replyTo?: string): Promise<SimTransportReceipt> {
    const target = targetFor(groupId, botId)
    if (ports.messageActions) {
      const parts: OutgoingPart[] = mentions.map(id => ({kind:'mention', user:{platform:target.account.platform, namespace:target.account.namespace, id}}))
      parts.push({kind:'text', text})
      return formatSimulationDelivery(await ports.messageActions.send({
        version:1, kind:'message.send', target, parts,
        ...(replyTo ? {replyTo} : {}), ...(options?.binding ? {binding:options.binding} : {}),
      }, options))
    }
    if (options?.isCurrent?.() === false) return {ok:false, error:'角色绑定或发送权限已改变'}
    const segments: unknown[] = mentions.map(qq => ({type:'at', data:{qq}}))
    if (replyTo) segments.unshift({type:'reply', data:{id:replyTo}})
    segments.push({type:'text', data:{text}})
    return await sendNativeMessage(target, segments, options)
  }

  function rememberDelivery(state: SimSessionState, receipt: SimTransportReceipt): void {
    if (!ports.durableIngress || receipt.messageId === undefined) return
    const id = String(receipt.messageId)
    state.confirmedMessageIds = [...(state.confirmedMessageIds ?? []).filter(item => item !== id), id].slice(-60)
  }

  function buildToolContext(groupId: string, state: SimSessionState, cfg: SimRuntimeConfig, addSends: (delta: number) => void, memoryBox: { list: SimMemoryEntry[]; sentTexts: string[]; deliveryUnknown?: boolean }, affinityBox: { map: SimAffinityMap }, selfMemoryBox: { list: SimMemoryEntry[] }, moodBox: { current: SimMoodState | null } = { current: null }, moodAnchor: Record<MoodAxis, number> | null = null, scope = scopeFor(groupId, state.botId), beforeSend?: () => Promise<void>, totalSends?: () => number, reviewSend?: (messages: string[]) => Promise<void>, directAddress = false, visibleMessages: () => SimMessage[] = () => [], sendOptions?: SimSendOptions): SimToolContext {
    const store = scopedStore(scope, sendOptions?.binding)
    const target = targetFor(groupId, state.botId || ports.getSelf().id)
    const qq = isQqSimulationAddress(target)
    let sendsThisTurn = 0
    const forwardSources = new Map<string, Set<number>>()
    const mediaCurrent = (sources: readonly SimMessage[]) => sendOptions?.isCurrent?.() !== false &&
      visibleMessages().some(message => sources.includes(message))
    const context: SimToolContext = {
      groupId: target.id,
      ...(qq ? {} : { platformUserId: isSimulationUserId }),
      now,
      getState: () => state,
      mutate: async fn => {
        const value = fn(state)
        await store.save(groupId, state)
        return value
      },
      sendMessage: async (messages, opts): Promise<SimSendResult> => {
        // B2 排队动作发送前重查：回合可能已持续数十秒，期间管理员可能关了仿真/切了群
        if (!groupActive(runtimeConfig(), groupId)) {
          return { ok: false, error: '仿真模式已对本群关闭，本轮不再发送消息' }
        }
        if (memoryBox.deliveryUnknown) return { ok: false, sent: 0, unknown: true, error: '上次发送结果未知，本回合不再发送，请核对回执' }
        const cleaned: string[] = []
        for (let i = 0; i < messages.length; i++) {
          const redacted = redactInternalStatusLeaks(messages[i])
          if (redacted.heavy) return { ok: false, sent: 0, error: `第 ${i + 1} 条包含大量内部状态特征，整批未发送，请换一句自然的说法` }
          cleaned.push(redacted.text)
        }
        const plan = planMessageDelivery({ messages: cleaned, deliveredTexts: memoryBox.sentTexts, state, config: cfg, at: now(), sendsThisTurn: totalSends?.() ?? sendsThisTurn, directAddress })
        if (!plan.ok) return { ok: false, sent: 0, error: plan.error, duplicatesSkipped: plan.duplicatesSkipped }
        let sent = 0, inFlight = false
        const failed = (error: string): SimSendResult => ({ ok: false, sent, duplicatesSkipped: plan.duplicatesSkipped, ...(memoryBox.deliveryUnknown ? { unknown: true } : {}), error })
        try {
          if (plan.messages.length) await reviewSend?.(plan.messages)
          // Review may take time. Check the entire remaining batch again before its first send.
          const latest = planMessageDelivery({ messages: plan.messages, deliveredTexts: memoryBox.sentTexts, state, config: cfg, at: now(), sendsThisTurn: totalSends?.() ?? sendsThisTurn, directAddress })
          if (!latest.ok) return failed(latest.error)
          for (let i = 0; i < latest.messages.length; i++) {
            await beforeSend?.()
            const itemAllowance = checkSendAllowance(state, cfg, now(), totalSends?.() ?? sendsThisTurn, directAddress)
            if (!itemAllowance.allowed) return failed(itemAllowance.reason)
            const text = latest.messages[i]!
            const replyTo = i === 0 && opts.replyToMessageId != null ? String(opts.replyToMessageId) : undefined
            inFlight = true
            const receipt = await sendTextMessage(groupId, target.account.id, text, sendOptions, (opts.atUserIds || []).map(String), replyTo)
            inFlight = false
            if (receipt.unknown) { memoryBox.deliveryUnknown = true; return failed(`第 ${sent + 1} 条回执未确认，是否送达未知，本回合不再发送（已确认 ${sent} 条）`) }
            if (!receipt.ok) return failed(`第 ${sent + 1} 条发送失败：${receipt.error || '网关错误'}（已确认 ${sent} 条，不自动重发）`)
            rememberDelivery(state, receipt)
            sent++
            sendsThisTurn++
            addSends(1)
            memoryBox.sentTexts.push(text)
            markConversationEngaged(state, state.conversation.lastTriggerUserId || '', cfg.wake.continuationWindowMs)
            const memeBumped = bumpMemeUsage(memoryBox.list, text, now()).length > 0
            recordSend(state, now(), 1)
            state.lastAiSendAt = now()
            invalidatePreSleepWaitByParticipation(state)
            // Confirmed delivery is durable before another network side effect.
            await store.save(groupId, state)
            if (memeBumped) await store.saveMemories(groupId, memoryBox.list, sendOptions?.isCurrent)
            if (i < latest.messages.length - 1) await sleep(boundedTimerDelay(cfg.turn.minSendGapMs + 400 + Math.floor(random() * 2600), 60_000))
          }
          return { ok: true, sent, duplicatesSkipped: plan.duplicatesSkipped }
        } catch (error) {
          if (inFlight) memoryBox.deliveryUnknown = true
          return failed(`${inFlight ? '传输中断，是否送达未知，本回合不再发送' : error instanceof Error ? error.message : '发送中断'}（已确认 ${sent} 条，不自动重发）`)
        }
      },
      waitForMessages: async (rawPlan: SimWaitPlan, filter?: (message: SimMessage) => boolean): Promise<SimWaitResult> => {
        const plan = normalizeWaitPlan(rawPlan, cfg.turn.waitQuietMaxMs, cfg.turn.waitTimeoutMaxMs)
        const baselineSeq = state.seq
        const baselineReadThrough = readThroughSeq(state)
        const startAt = now()
        const deadline = startAt + plan.timeoutMs
        for (;;) {
          if (stopped) throw new Error('仿真运行时已停止')
          const at = now()
          const arrived = state.unread.filter(m => m.seq > baselineSeq && (!filter || filter(m))).slice(-4)
          const lastNewIncomingAt = arrived.length ? Math.max(...arrived.map(m => m.at)) : state.lastIncomingAt
          let done: boolean
          if (plan.purpose === 'reply') {
            done = at - Math.max(state.lastIncomingAt, 0) >= plan.quietMs
          } else {
            done = arrived.length >= plan.minNewMessages && at - Math.max(lastNewIncomingAt, 0) >= plan.minQuietAfterNewMs
          }
          if (done || at >= deadline) {
            const outcome = computeWaitOutcome(state, plan, arrived, at, lastNewIncomingAt, at >= deadline && !done)
            const seqs = arrived.map(m => m.seq)
            noteModelSeen(state, seqs)
            context.noteVisibleMessages?.(seqs)
            if (outcome.countsAsObservation) markPreSleepSatisfied(state, at)
            await store.save(groupId, state)
            return {
              hint: outcome.hint,
              canSleepNow: outcome.canSleepNow,
              newMessagesText: arrived.map(m => compactSimMessage(m, at)).join('\n'),
              newCount: arrived.length,
              readThroughSeq: Math.max(baselineReadThrough, readThroughSeq(state)),
              partial: false,
            }
          }
          await waitForArrival(groupId, Math.min(500, Math.max(50, deadline - at)))
        }
      },
      applyWakeConfig: async config => {
        const previous = state.wakeConfig
        state.wakeConfig = config
        try { await store.save(groupId, state) } catch (error) { state.wakeConfig = previous; throw error }
      },
      sendsThisTurn: () => sendsThisTurn,
      maxSendItems: () => cfg.turn.maxSendsPerTurn,
      messageTextMaxChars: () => cfg.turn.messageTextMaxChars,
      getMemories: () => memoryBox.list,
      saveMemories: async memories => { await store.saveMemories(groupId, memories, sendOptions?.isCurrent); memoryBox.list = memories },
      getAffinity: () => affinityBox.map,
      saveAffinity: async map => { await store.saveAffinity(groupId, map); affinityBox.map = map },
      qzoneConfig: () => cfg.qzone,
      ...(typeof store.bumpGlobalAffinity === 'function' ? { bumpGlobalAffinity: (userId: string, delta: number, reason?: string) => store.bumpGlobalAffinity(userId, delta, reason) } : {}),
      preparePersonMemory: async (entry, sourceSeq, sourceQuote) => {
        await beforeSend?.()
        const seq = sourceSeq ?? (entry.kind === 'pendingEvent' ? context.proactiveSourceSeq?.() : undefined)
        const message = visibleMessages().find(item => item.seq === seq)
        if (!message || message.kind !== 'text' || message.forwardId || message.textTruncated || message.messageId === null || !entry.aboutUser) throw new Error('人物笔记需要本轮可见且完整的真实用户消息 sourceSeq')
        const quote = (sourceQuote || (entry.kind === 'pendingEvent' ? message.text : '')).trim()
        if (!quote || !message.text.includes(quote)) throw new Error('sourceQuote 必须是 sourceSeq 消息中的精确原话片段')
        const source = { scene: { kind: 'group' as const, id: scope.groupId }, authorId: message.userId, messageId: String(message.messageId), at: message.at, excerpt: quote }
        const result = await store.rememberPersonMemory({ subjectId: entry.aboutUser, text: entry.content,
          category: entry.kind === 'pendingEvent' ? 'event' : entry.kind === 'impression' ? 'impression' : entry.kind === 'interaction' ? 'relationship' : 'fact',
          source, evidenceKind: message.userId === entry.aboutUser && entry.kind !== 'impression' ? 'self' : 'inferred',
          sensitivity: 'personal', portable: false, confidence: 0.7,
          ...(entry.dueAt ? { eventAt: entry.dueAt } : {}), ...(entry.expiresAt ? { validUntil: entry.expiresAt } : {}) })
        if (!result.saved || !result.entry) throw new Error(`人物记忆未保存：${result.reason || '来源已撤销或记忆已关闭'}`)
        return { memorySource: source, memoryIdentity: { botId: scope.botId, personaId: scope.personaId }, personMemoryId: result.entry.id }
      },
      forgetPersonMemory: async entry => {
        if (!entry.aboutUser) return
        await store.forgetPersonMemory(entry.aboutUser, entry.personMemoryId ? { id: entry.personMemoryId } : { text: entry.content })
      },
      ...(typeof store.loadSelfMemories === 'function' && typeof store.saveSelfMemories === 'function' ? {
        getSelfMemories: () => selfMemoryBox.list,
        saveSelfMemories: async (list: SimMemoryEntry[]) => { await store.saveSelfMemories(list); selfMemoryBox.list = list },
      } : {}),
      ...(cfg.mood.enabled && typeof store.saveMood === 'function' ? {
        getMood: () => (moodBox.current ? { summary: moodSummaryLine(moodBox.current, now(), cfg.mood.halfLifeMs) } : null),
        updateMood: async (deltas: Parameters<NonNullable<SimToolContext['updateMood']>>[0], reason: string) => {
          const result = applyMoodUpdate({ mood: moodBox.current, deltas, reason, now: now(), halfLifeMs: cfg.mood.halfLifeMs, maxStep: cfg.mood.maxStep, ...(moodAnchor ? { turnAnchor: moodAnchor } : {}) })
          // 全部被包络夹成零变化 → 不落盘（更新 updatedAt 会白刷新衰减起点，等于无事件续命情绪）
          if (!Object.values(result.applied).some(v => v !== 0)) return { error: '没有产生实际变化（可能已到本轮变化上限）' }
          await store.saveMood(result.mood)
          moodBox.current = result.mood
          return { mood: result.mood, applied: result.applied, capped: result.capped }
        },
      } : {}),
      setRhythm: async (sleepFrom: number, sleepTo: number) => {
        await store.saveRhythm({ sleepFrom, sleepTo, setBy: 'agent' })
        rhythmCache = null
        return `已设定你的作息：${sleepFrom}:00 睡到 ${sleepTo}:00。这个时间你会更少说话（被@还是会回），对话中可以自然提到自己的作息习惯。`
      },
      ...(typeof ports.lifeThreadResolve === 'function' ? {
        lifeThreadFollow: async (title: string) => {
          const threads = normalizeLifeThreads(await store.loadLifeThreads().catch(() => []))
          const activeCount = threads.filter(t => t.status === 'active').length
          const existing = threads.find(t => t.title.includes(title) || title.includes(t.title))
          if (existing && existing.status === 'active') return { ok: false, error: `你已经在追《${existing.title}》了` }
          if (activeCount >= 3 && !existing) return { ok: false, error: '最多同时追 3 部——先弃掉一部再追新的（drop）' }
          const resolved = await ports.lifeThreadResolve!({ title })
          if (!resolved.ok) return resolved
          const next = normalizeLifeThreads([...threads, { id: `lt-${Date.now()}`, kind: 'anime' as const, title: resolved.title, sourceId: resolved.sourceId, status: 'active' as const, addedAt: now(), lastSyncAt: 0, ...(resolved.episode ? { lastEpisode: resolved.episode } : {}), notes: [] }])
          await store.saveLifeThreads(next)
          return { ok: true, title: resolved.title }
        },
        lifeThreadList: async () => {
          const threads = normalizeLifeThreads(await store.loadLifeThreads().catch(() => []))
          return threads.map(t => ({ title: t.title, status: t.status, ...(t.lastEpisode ? { lastEpisode: t.lastEpisode } : {}), notes: t.notes }))
        },
        lifeThreadDrop: async (title: string) => {
          const threads = normalizeLifeThreads(await store.loadLifeThreads().catch(() => []))
          const target = threads.find(t => t.title.includes(title) || title.includes(t.title))
          if (!target) return { ok: false, error: `没找到《${title}》` }
          target.status = 'dropped'
          await store.saveLifeThreads(threads)
          return { ok: true }
        },
      } : {}),
      ...(qq && typeof ports.qzoneInteract === 'function' ? { qzoneInteract: async (input: { action: 'visit' | 'like' | 'comment'; userId?: string; tid?: string; text?: string }) => {
        if (memoryBox.deliveryUnknown) return { ok: false, error: '上次发送结果未知，本回合不再进行外部互动，请核对回执' }
        await beforeSend?.()
        return ports.qzoneInteract!(input, target, sendOptions)
      } } : {}),
      ...(qq && typeof ports.pokeMember === 'function' ? { pokeMember: async (userId: string) => {
        if (memoryBox.deliveryUnknown) return { ok: false, error: '上次发送结果未知，本回合不再发送，请核对回执' }
        if (!qq || typeof ports.pokeMember !== 'function') return { ok: false, error: '戳一戳不可用' }
        if (!/^\d{1,12}$/.test(userId)) return { ok: false, error: 'userId 必须是 QQ 号' }
        const window = (pokeTimes.get(groupId) || []).filter(t => now() - t < 3600_000)
        if (window.length >= 6) return { ok: false, error: '本小时戳人次数已达上限（6），别把人戳烦了' }
        await beforeSend?.()
        const receipt = await ports.pokeMember(target.id, userId, target.account.id)
        if (receipt.ok) { window.push(now()); pokeTimes.set(groupId, window) }
        return receipt
      } } : {}),
      ...(typeof ports.readGroupMembers === 'function' || qq && typeof ports.getGroupMembers === 'function' ? { getGroupMembers: async () => {
        try {
          await beforeSend?.()
          const snapshot = ports.readGroupMembers ? await ports.readGroupMembers(target, AbortSignal.timeout(5000), () => sendOptions?.isCurrent?.() !== false) : undefined
          if (ports.readGroupMembers && !snapshot) return { error: '当前群成员无法核实' }
          const members = snapshot ? snapshot.members.map(member => ({ userId: member.user.id, nick: member.displayName })) : await ports.getGroupMembers!(target.id, target.account.id)
          await beforeSend?.()
          const activeIds = new Set(state.recent.map(m => m.userId))
          const sorted = [...members].sort((a, b) => Number(activeIds.has(b.userId)) - Number(activeIds.has(a.userId)))
          return sorted.slice(0, 40).map(m => ({ userId: m.userId, nick: m.nick, active: activeIds.has(m.userId) }))
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) }
        }
      } } : {}),
      ...(qq && typeof ports.getForwardContent === 'function' ? { getForward: async (forwardId: string, seq?: number) => {
        if (!qq || typeof ports.getForwardContent !== 'function') return { lines: [], error: '合并转发查看不可用' }
        const visible = visibleMessages()
        const id = seq === undefined ? forwardId : visible.find(message => message.seq === seq)?.forwardId
        if (!id) return { lines: [], error: '该消息不含可见的合并转发' }
        const inherited = forwardSources.get(id)
        const anchors = visible.filter(message => (seq === undefined || message.seq === seq) && (message.forwardId === id || inherited?.has(message.seq)))
        if (!anchors.length) return { lines: [], error: '该转发不属于本轮可见消息，或来源已撤销' }
        const isCurrent = () => mediaCurrent(anchors)
        const changed = { lines: [], error: '转发来源或角色绑定已改变' }
        if (!isCurrent()) return changed
        const result = await ports.getForwardContent(id, target.account.id, { isCurrent })
        if (!isCurrent()) return changed
        for (const nested of result.nestedForwardIds || []) forwardSources.set(nested, new Set(anchors.map(message => message.seq)))
        // 转发里的图片真实取回（≤FORWARD_MAX_MODEL_IMAGES 张）→ 以 vision 消息注入，模型能"看见"
        const urls = (result.imageUrls || []).slice(0, 3)
        const images: { mime: string; base64: string }[] = []
        if (urls.length && typeof ports.fetchImageBase64 === 'function') {
          for (const url of urls) {
            if (!isCurrent()) return changed
            try {
              const fetched = await ports.fetchImageBase64(url, { isCurrent })
              if ('base64' in fetched && fetched.base64) images.push({ mime: fetched.mime, base64: fetched.base64 })
            } catch { /* 单张失败不影响 */ }
          }
          if (!isCurrent()) return changed
        }
        return {
          lines: result.lines || [],
          ...(images.length ? { images } : {}),
          ...((result.imageUrls || []).length > urls.length ? { imagesNotShown: (result.imageUrls || []).length - urls.length } : {}),
          ...(Array.isArray(result.nestedForwardIds) && result.nestedForwardIds.length ? { nestedForwardIds: result.nestedForwardIds } : {}),
          ...(result.error ? { error: result.error } : {}),
        }
      } } : {}),
      ...(qq && typeof ports.collectStickerImage === 'function' ? { collectSticker: async (seq: number) => {
        if (!qq || typeof ports.collectStickerImage !== 'function') return { ok: false, error: '收藏不可用' }
        const message = [...state.unread, ...state.recent].find(m => m.seq === seq)
        const url = message?.imageUrls?.[0]
        if (!url) return { ok: false, error: '这条消息没有可收藏的图片' }
        return await ports.collectStickerImage(target.id, url)
      } } : {}),
      ...(qq && typeof ports.resolveBilibiliCard === 'function' && typeof ports.sendGroupMessage === 'function' ? { shareVideoCard: async (input: { query?: string; url?: string }) => {
        if (memoryBox.deliveryUnknown) return { ok: false, unknown: true, error: '上次发送结果未知，本回合不再发送，请核对回执' }
        if (!qq || typeof ports.resolveBilibiliCard !== 'function') return { ok: false, error: 'B站卡片分享不可用' }
        const last = videoCardAt.get(groupId) || 0
        if (now() - last < 20 * 60_000) {
          const waitSec = Math.ceil((20 * 60_000 - (now() - last)) / 1000)
          return { ok: false, error: `B站卡片冷却中（还要 ${waitSec} 秒）。别刷屏，本回合换文字说。` }
        }
        const resolved = await ports.resolveBilibiliCard(input || {})
        if (!resolved.ok) return { ok: false, error: resolved.error || '没找到合适的视频' }
        await beforeSend?.()
        const allowance = checkSendAllowance(state, cfg, now(), totalSends?.() ?? sendsThisTurn, directAddress)
        if (!allowance.allowed) return { ok: false, error: allowance.reason }
        let receipt
        try { receipt = await sendNativeMessage(target, [{ type: 'json', data: { data: resolved.cardJson || '' } }], sendOptions) }
        catch { memoryBox.deliveryUnknown = true; return { ok: false, unknown: true, error: '卡片传输中断，是否送达未知，本回合不再发送' } }
        if (receipt.unknown) { memoryBox.deliveryUnknown = true; return { ok: false, unknown: true, error: '卡片回执未确认，是否送达未知，本回合不再发送' } }
        if (!receipt.ok) return { ok: false, error: receipt.error || '卡片发送失败' }
        videoCardAt.set(groupId, now())
        addSends(1)
        sendsThisTurn += 1
        recordSend(state, now(), 1)
        state.lastAiSendAt = now()
        await store.save(groupId, state)
        return { ok: true, title: resolved.title || '' }
      } } : {}),
      ...(qq && typeof ports.fetchImageBase64 === 'function' ? { getMessageImages: async (seq: number) => {
        const message = visibleMessages().find(m => m.seq === seq)
        if (!message) return { seq, images: [], error: '该消息不在本轮可见范围内' }
        // 引用别人的带图消息是常见的"给你看"信号:本消息的图优先,没有则回落被引消息的图
        const urls = [...(message.imageUrls || []).slice(0, 2), ...(message.imageUrls || []).length ? [] : (message.quoteImageUrls || []).slice(0, 2)]
        if (!urls.length) return { seq, images: [], error: '这条消息没有可取的图片（或图片 URL 已过期）' }
        if (typeof ports.fetchImageBase64 !== 'function') return { seq, images: [], error: '图片读取不可用' }
        const isCurrent = () => mediaCurrent([message])
        const changed = { seq, images: [], error: '图片来源或角色绑定已改变' }
        const images: { mime: string; base64: string }[] = []
        for (const url of urls) {
          if (!isCurrent()) return changed
          try {
            const result = await ports.fetchImageBase64(url, { isCurrent })
            if ('error' in result && result.error) continue
            if ('base64' in result && result.base64) images.push({ mime: result.mime, base64: result.base64 })
          } catch { /* 单张失败不影响其他 */ }
        }
        if (!isCurrent()) return changed
        return images.length ? { seq, images } : { seq, images: [], error: '图片下载失败（URL 可能已过期）' }
      } } : {}),
    }
    return context
  }

  function waitForArrival(groupId: string, timeoutMs: number): Promise<void> {
    return new Promise(resolve => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        const set = waiters.get(groupId)
        if (set) { set.delete(finish); if (!set.size) waiters.delete(groupId) }
        clearTimeout(timer)
        resolve()
      }
      let set = waiters.get(groupId)
      if (!set) { set = new Set(); waiters.set(groupId, set) }
      set.add(finish)
      const timer = safeSetTimeout(finish, timeoutMs, 120_000)
    })
  }

  function sweepOnce(): Promise<void> {
    if (ports.durableIngress) {
      const existing = activeSweeps.values().next().value
      if (existing) return existing
    }
    const sweep = sweepSessions()
    activeSweeps.add(sweep)
    void sweep.finally(() => activeSweeps.delete(sweep)).catch(() => {})
    return sweep
  }

  async function sweepSessions(): Promise<void> {
    if (stopped) return
    await refreshGroupState(true)
    // allGroups 模式下无法枚举白名单群，sweep 遍历「登记过的群」∩ 当前生效判定
    const commonConfig = runtimeConfig()
    const groups = knownGroupsCache.filter(groupId => groupActive(commonConfig, groupId))
    for (const groupId of groups) {
      if (running.has(groupId) || background.has(groupId) || pendingWakes.has(groupId) || retryTimers.has(groupId)) continue
      let state: SimSessionState
      try { state = await store.load(groupId) } catch (error) { logger.error(`[仿真] 群 ${groupId} sweep 读取失败`, error); continue }
      if (!state.botId && decodeSimulationAddressKey(groupId)) continue
      const target = targetFor(groupId, state.botId || ports.getSelf().id)
      if (!handlesTarget(target) || ports.allowsSimulation?.(target) === false || (state.botId && state.botId !== target.account.id)) continue
      if (ports.isAccountReady?.(target.account) === false) continue
      const cfg = runtimeConfig(groupId)
      let binding: AgentBindingSnapshot | undefined
      try { binding = personaFor(target).binding } catch {
        logger.warn(`[仿真] 群 ${groupId} 角色绑定无效，跳过本次调度`)
        continue
      }
      if (running.has(groupId) || background.has(groupId) || pendingWakes.has(groupId) || retryTimers.has(groupId) || ingressQueue.has(groupId)) continue
      const previousBinding = state.bindingToken
      const bindingChanged = alignSessionBinding(state, binding)
      const bindingToken = state.bindingToken
      const isCurrent = () => {
        try {
          const live = personaFor(target).binding
          return !stopped && ports.isAccountReady?.(target.account) !== false && (live ? agentBindingToken(live) : undefined) === bindingToken
        } catch { return false }
      }
      if (bindingChanged) {
        await store.save(groupId, state)
        continue
      }
      if (ports.durableIngress && state.queuedIngressWake) {
        const queued = state.queuedIngressWake
        if (queued.seq === undefined || state.recent.some(message => message.seq === queued.seq)) {
          if (isCurrent()) await scheduleWake(groupId, queued, bindingToken, cfg)
          continue
        }
        delete state.queuedIngressWake
        await store.save(groupId, state)
      }
      const at = now()
      const reasons: SimWakeReason[] = []
      let scheduleChanged = false
      const sleepUntil = state.wakeConfig.sleepUntil
      const timeoutDue = state.wakeConfig.mode === 'active' && typeof sleepUntil === 'number' && at >= sleepUntil
      if (timeoutDue) reasons.push({ kind: 'timeout' })
      if (state.pendingWakeReasons.length) {
        const pending = state.pendingWakeReasons
        state.pendingWakeReasons = []
        for (const reason of pending) if (messageReasonStillPending(reason, state.unread)) reasons.push(reason)
      }
      if (state.nextReplyCheckAt && at >= state.nextReplyCheckAt) {
        state.nextReplyCheckAt = 0
        scheduleChanged = true
        if (state.unread.some(message => message.at > state.lastAiSendAt && (message.atSelf || message.quoteToSelf || (!message.atOther && !message.replyToUserId)))) {
          reasons.push({ kind: 'replyCheck' })
        }
      }
      // 仅@才回的群不主动冒泡：静默期检查照常排期，但不产生 proactiveCheck 唤醒；睡眠窗口内同样不冒泡
      const atOnly = (overridesCache?.atOnly || []).includes(groupId)
      let sleepingNow = false
      if (cfg.rhythm.enabled) {
        const rhythmWin = await loadRhythmWindow(cfg, scopeFor(groupId, state.botId))
        sleepingNow = isSleeping(new Date(now() + 8 * 3600_000).getUTCHours(), rhythmWin)
      }
      if (!atOnly && !sleepingNow && state.lastIncomingAt > 0 && at - state.lastIncomingAt >= cfg.wake.proactiveIdleMs && at >= state.nextProactiveCheckAt) {
        state.nextProactiveCheckAt = at + cfg.wake.proactiveCheckMinMs + Math.floor(random() * Math.max(1, cfg.wake.proactiveCheckMaxMs - cfg.wake.proactiveCheckMinMs))
        scheduleChanged = true
        if (cfg.wake.proactiveProbability > 0) {
          try {
            const memories = await sceneMemories(groupId, at)
            const next = dueMemories(memories, at).find(item => item.proactiveSourceSeq !== undefined && !state.offeredFollowUpIds?.includes(item.id))
            if (next) reasons.push({ kind: 'proactiveCheck', detail: next.id })
            else if (state.recent.some(message => message.seq > (state.lastProactiveCheckedSeq ?? 0) && message.at > state.lastAiSendAt) &&
              random() < cfg.wake.proactiveProbability) reasons.push({ kind: 'proactiveCheck' })
          } catch (error) {
            logger.warn(`[仿真] 群 ${groupId} 社交跟进检查失败：${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }
      if (!atOnly && !sleepingNow && isCurrent()) {
        try {
          const scope = scopeFor(groupId, state.botId)
          await recoverCharacter(scope)
          const current = await characters.update(scope, value => expireCharacterGoals(value, at))
          const cutoff = (await personMemory.getSceneRedactions({ identity: scope, scene: { kind: 'group', id: scope.groupId } })).invalidatedAt
          const due = dueCharacterGoal({ ...current, goals: characterMemoryVisibility(current, cutoff).goals }, at)
          if (due) reasons.push({ kind: 'characterGoal', detail: due.id })
        } catch (error) { logger.warn(`[仿真] 群 ${groupId} 角色目标检查失败：${error instanceof Error ? error.message : String(error)}`) }
      }
      if (!isCurrent() || running.has(groupId) || background.has(groupId) || pendingWakes.has(groupId) || ingressQueue.has(groupId)) continue
      const hasWake = reasons.length > 0
      const [first, ...rest] = reasons
      const best = first && rest.reduce((acc, r) => mergeWakeReason(acc, r).reason, first)
      // A higher-priority wake leaves the durable timer available for the next sweep.
      if (timeoutDue && (!ports.durableIngress || best?.kind === 'timeout')) {
        const { sleepUntil: _consumedDeadline, ...settings } = state.wakeConfig
        state.wakeConfig = { ...settings, mode: 'diving' }
      }
      if (ports.durableIngress && best) {
        state.queuedIngressWake = best
        state.pendingWakeReasons = reasons.filter(reason => reason !== best && isDirectAddressKind(reason.kind)).slice(0, 20)
      }
      if (hasWake || scheduleChanged || previousBinding !== state.bindingToken) await store.save(groupId, state)
      if (best) await scheduleWake(groupId, best, state.bindingToken, cfg)
      if (!hasWake && !running.has(groupId) && !background.has(groupId) && !atOnly && !sleepingNow &&
          ports.isMemoryInputAvailable?.(target.account) !== false) await runCharacterBackground(groupId, state, cfg, binding)
      // 本群专属梗自动提取（独立于唤醒：不产生回合，只沉淀记忆）
      if (!hasWake && !running.has(groupId)) await maybeExtractMemes(groupId, state, cfg)
      if (!hasWake && !running.has(groupId)) await maybeExtractPersonProfiles(groupId, state, cfg)
      // 按人挖口头禅（风格个性化）：冷却默认 6h，读归档 → 纯函数挖掘 → Redis
      if (!hasWake && !running.has(groupId)) await maybeMineUserStyle(groupId, cfg)
      if (!hasWake && !running.has(groupId) && isCurrent()) await maybeSyncLifeThreads(cfg, scopedStore(scopeFor(groupId, state.botId)), isCurrent)
      // 健康哨兵：全局每小时跑一次（挂在第一个群的 sweep 里）
      if (now() - healthSentinelLastRun > 3600_000) {
        healthSentinelLastRun = now()
        void runHealthSentinel()
      }
    }
  }

  /** One bounded background activity per group; no chat-sending port is passed to reflection. */
  async function runCharacterBackground(groupId: string, state: SimSessionState, cfg: SimRuntimeConfig, binding?: AgentBindingSnapshot): Promise<void> {
    const scope = scopeFor(groupId, state.botId)
    const target = targetFor(groupId, state.botId || ports.getSelf().id)
    const scene = { kind: 'group' as const, id: scope.groupId }
    const bindingToken = state.bindingToken
    let bindingCurrent = true
    background.add(groupId)
    liveStates.set(groupId, state)
    const shared = sharedFor(scope)
    let fingerprint = ''
    let sources = new Set<string>()
    const controller = new AbortController()
    let activityVersion = ''
    let memoryInvalidatedAt = 0
    let memoryTurn: Awaited<ReturnType<NonNullable<SimulationRuntimePorts['beginMemoryTurn']>>> | undefined
    backgroundControllers.add(controller)
    backgroundByGroup.set(groupId, controller)
    const canCallModel = () => {
      if (stopped || controller.signal.aborted || memoryTurn?.isCurrent() === false ||
          ports.isAccountReady?.(target.account) === false || !handlesTarget(target) || ports.allowsSimulation?.(target) === false) return false
      const live = personaFor(target)
      bindingCurrent = bindingCurrent && (live.personaId || 'default') === scope.personaId &&
        (live.binding ? agentBindingToken(live.binding) : undefined) === bindingToken
      return bindingCurrent && groupActive(runtimeConfig(), groupId) && !(overridesCache?.atOnly || []).includes(groupId)
    }
    const guard = async () => {
      await refreshGroupState(true)
      if (!canCallModel()) throw new Error('角色后台活动范围已改变')
      const current = await characters.load(scope)
      if (current.paused || [...sources].some(id => !activeCharacterMemories(current).some(m => m.id === id)) || await shared.fingerprint() !== fingerprint) throw new Error('角色暂停或来源已撤销')
      if (await store.loadActivityVersion(groupId) !== activityVersion ||
          (await personMemory.getSceneRedactions({ identity: scope, scene })).invalidatedAt !== memoryInvalidatedAt ||
          memoryTurn?.isCurrent() === false) throw new Error('角色活动或人物记忆来源已撤销')
      if (!canCallModel()) throw new Error('角色后台活动范围已改变')
    }
    try {
      if (ports.isMemoryInputAvailable?.(target.account) === false) return
      if (binding && ports.beginMemoryTurn) memoryTurn = await ports.beginMemoryTurn(binding)
      memoryInvalidatedAt = (await personMemory.getSceneRedactions({ identity: scope, scene })).invalidatedAt
      activityVersion = await store.loadActivityVersion(groupId)
      fingerprint = await shared.fingerprint()
      sources = new Set(characterMemoryVisibility(await characters.load(scope), memoryInvalidatedAt).memories.map(m => m.id))
      await guard()
      if (!(await checkGroupWakeBudget(state, runtimeConfig(groupId), groupId)).allowed) return
      const subscriptions = subscriptionsFor(scope)
      const dueSubscriptions = (await subscriptions.list()).some(item => item.status === 'active' && item.nextPollAt <= now())
      const pollReceiptId = dueSubscriptions ? randomUUID() : undefined
      if (pollReceiptId) await characters.update(scope, current => recordCharacterReceipt(current, { id: pollReceiptId, toolName: 'simSubscriptionPoll', status: 'pending', summary: '等待公开订阅抓取回执', at: now() }, now()))
      let update: Awaited<ReturnType<typeof subscriptions.poll>>
      try {
        update = await subscriptions.poll(guard)
        if (pollReceiptId) await characters.update(scope, current => recordCharacterReceipt(current, {
          id: pollReceiptId, toolName: 'simSubscriptionPoll', status: update.unknowns ? 'unknown' : update.failures && !update.updates.length ? 'failed' : 'succeeded',
          summary: (update.updates.length ? `取得公开订阅资料（未经事实核实）：${update.updates.slice(0,3).map(item => item.title).join('；')}${update.failures ? `；另有${update.failures}个订阅未取得结果` : ''}` : update.unknowns ? `${update.unknowns}个订阅超时，结果未知，未取得新资料` : update.failures ? `${update.failures}个订阅抓取失败，未取得新资料` : '订阅检查完成，没有新资料').slice(0,500), at: now(),
        }, now()))
      } catch (error) {
        if (pollReceiptId) await characters.update(scope, current => recordCharacterReceipt(current, { id: pollReceiptId, toolName: 'simSubscriptionPoll', status: 'unknown', summary: '订阅检查中断，结果未知', at: now() }, now()))
        throw error
      }
      await guard()
      if (update.updates.length) {
        state.pendingWakeReasons = pushPendingReason(state.pendingWakeReasons, { kind: 'interestUpdate', detail: update.updates.slice(0,2).map(item => item.title).join('；').slice(0,200) })
        await store.save(groupId, state)
      }
      if (!update.updates.length && ports.reflectCharacter && ports.getSection().reflection?.enabled !== false) {
        const reflection = reflectionFor(scope)
        await reflection.run({ guard, memoryInvalidatedAt, sharedSources: (await shared.contextProjection()).map(item => item.id),
          ...(ports.getSection().consistency?.enabled === true ? { review: async (candidate: Record<string, unknown>, before: CharacterState, evidence: unknown) => {
            await guard()
            if (ports.getSection().consistency?.enabled !== true) return
            const reviewer = createCharacterConsistencyReviewer({ maxChecks: 1,
              infer: (request, signal) => {
                if (memoryTurn?.isCurrent() === false) throw new Error('人物记忆权限已改变')
                if (!ports.reviewCharacter) throw new Error('角色审核端口未配置')
                return ports.reviewCharacter(request, ports.getExecutionConfig(), AbortSignal.any([
                  signal, controller.signal, ...(memoryTurn ? [memoryTurn.signal] : []),
                ]), canCallModel, guard)
              },
              onResult: result => {
                recordWakeTokens(state, Number(record(result.usage).total_tokens) || 0)
                try { ports.recordTokens?.({ scope: groupId, stage: 'character-consistency', model: result.model ?? '', usage: result.usage, ms: result.ms }) } catch { /* wake ledger still contains reported tokens */ }
              },
            })
            const normalized = { ...candidate, updates: Array.isArray(candidate.updates) ? candidate.updates.map(item => ({ ...record(item), epistemic: 'inferred' })) : candidate.updates }
            const verdict = await reviewer.review({ toolName: 'characterReflection', candidate: normalized, state: before, sources: evidence })
            await store.save(groupId, state)
            await guard()
            if (verdict.verdict !== 'accept') throw new Error(`反思一致性检查未通过，本次变更未保存：${verdict.error || JSON.stringify(verdict.issues)}`)
          } } : {}),
          reserve: async () => {
            await guard()
            if (!(await checkGroupWakeBudget(state, runtimeConfig(groupId), groupId)).allowed) throw new Error('反思预算已达到上限')
            rollBudgetDay(state, now()); recordWake(state, now()); await store.save(groupId, state)
          },
          infer: async prompt => {
            if (memoryTurn?.isCurrent() === false) throw new Error('人物记忆权限已改变')
            const timeout = setTimeout(() => controller.abort(), 30_000)
            timeout.unref?.()
            try {
              const signal = memoryTurn ? AbortSignal.any([controller.signal, memoryTurn.signal]) : controller.signal
              const response = await ports.reflectCharacter!({ messages: [{ role: 'system', content: prompt }, { role: 'user', content: '请根据以上材料进行本次反思，只返回规定 JSON。' }], temperature: 0.3, max_tokens: 1200 }, ports.getExecutionConfig(), signal, canCallModel, guard)
              const usage = record(response.usage)
              recordWakeTokens(state, Number(usage.total_tokens) || 0)
              await store.save(groupId, state)
              ports.recordTokens?.({ scope: groupId, stage: 'character-reflection', model: String(response.model || ''), usage })
              if (response.error) throw new Error('反思模型返回错误')
              const content = response.choices?.[0]?.message?.content
              if (typeof content !== 'string' || content.length > 12_000) throw new Error('反思未返回有效结构')
              return content
            } finally { clearTimeout(timeout) }
          },
        })
        const reflected = await characters.load(scope)
        const active = characterMemoryVisibility(reflected, memoryInvalidatedAt).memories
        if ([...sources].some(id => !active.some(memory => memory.id === id))) {
          await store.invalidateActivity(groupId)
          state.agentHistory = []
          await workspaceFor(scope).pruneEvidence([...active.map(memory => `memory:${memory.id}`), ...characterMemoryVisibility(reflected, memoryInvalidatedAt).receipts.map(receipt => `receipt:${receipt.id}`)])
        }
      }
    } catch (error) { logger.warn(`[仿真] 群 ${groupId} 后台活动停止：${error instanceof Error ? error.message : String(error)}`) }
    finally {
      memoryTurn?.release()
      let pending: SimWakeReason[] = []
      let finalSave: Promise<void> | undefined
      try {
        // Keep sharing the live object until the in-flight snapshot settles. Ingress may
        // add messages and wakes while Redis is slow; capture those only after this await.
        await store.save(groupId, state)
        pending = (bindingCurrent ? state.pendingWakeReasons : []).filter(reason => messageReasonStillPending(reason, state.unread))
        state.pendingWakeReasons = []
        const [first, ...rest] = pending
        const next = first && rest.reduce((best, reason) => mergeWakeReason(best, reason).reason, first)
        if (ports.durableIngress && next) {
          state.pendingWakeReasons = pending.filter(reason => reason !== next && isDirectAddressKind(reason.kind))
          const best = queueWake(state, next)
          pending = [best]
        }
        // Queue the handoff snapshot before releasing ownership. New loads wait for this
        // write, and all session SETs execute in order so an old SET cannot erase ingress.
        finalSave = store.save(groupId, state)
      } finally {
        backgroundControllers.delete(controller)
        backgroundByGroup.delete(groupId)
        background.delete(groupId)
        liveStates.delete(groupId)
        notifyWaiters(groupId)
      }
      await finalSave
      if (!stopped && pending.length) await scheduleWake(groupId, pending.reduce((a,b) => mergeWakeReason(a,b).reason), state.bindingToken, cfg)
    }
  }

  /** 梗提取管线：冷却 + 游标之后的新消息达到阈值才调侧路小模型；合并入库后等下次唤醒注入。 */
  async function maybeExtractMemes(groupId: string, state: SimSessionState, cfg: SimRuntimeConfig): Promise<void> {
    if (!cfg.meme.enabled || typeof ports.memeExtract !== 'function' || !state.botId) return
    const at = now()
    const target = targetFor(groupId, state.botId)
    const resolved = personaFor(target)
    const scope = characterScopeFor(target, resolved.personaId || 'default')
    const scene = { kind: 'group' as const, id: scope.groupId }
    const memoryStore = scopedStore(scope, resolved.binding)
    const token = resolved.binding ? agentBindingToken(resolved.binding) : undefined
    if (state.bindingToken !== token) return
    const privacy = await personMemory.getSceneRedactions({ identity: scope, scene })
    const activityVersion = await store.loadActivityVersion(groupId)
    const cursor = state.memeCursor
    if (cursor && at - cursor.at < cfg.meme.extractCooldownMs) return
    const fresh = (await redactSceneMessages(scope, state.recent)).filter(m => m.at > privacy.invalidatedAt && m.seq > (cursor?.seq ?? Math.max(0, state.seq - 40)))
    if (fresh.length < cfg.meme.extractMinMessages) return
    try {
      const extractStartedAt = now()
      const raw = await ports.memeExtract(fresh.slice(-40).map(m => ({ name: m.name, text: m.text })))
      try { ports.recordTokens?.({ scope: groupId, stage: 'meme-extract', ms: now() - extractStartedAt }) } catch { /* 账本不可用 */ }
      const candidates = parseMemeCandidates(raw)
      if (stopped || await store.loadActivityVersion(groupId) !== activityVersion ||
        (await personMemory.getSceneRedactions({ identity: scope, scene })).invalidatedAt !== privacy.invalidatedAt) return
      if (!candidates.length) return
      // 回合可能刚改过记忆库：重新加载合并，避免双写者互覆
      const current = normalizeMemoryList(await memoryStore.loadMemories(groupId), at, isQqSimulationAddress(target) ? undefined : isSimulationUserId)
      const { memories, newCount } = mergeMemeCandidates(current, candidates, at)
      await memoryStore.saveMemories(groupId, memories, () => {
        const live = personaFor(target)
        return !stopped && (live.personaId || 'default') === scope.personaId &&
          (live.binding ? agentBindingToken(live.binding) : undefined) === token
      })
      await saveExtractionCursor(groupId, token, 'memeCursor', fresh.at(-1)!.seq, at)
      if (newCount > 0) logger.info(`[仿真] 群 ${groupId} 梗库新增 ${newCount} 条（提取自 ${fresh.length} 条消息）`)
    } catch (error) {
      logger.warn(`[仿真] 群 ${groupId} 梗提取失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async function saveExtractionCursor(groupId: string, bindingToken: string | undefined, cursor: 'memeCursor' | 'personProfileCursor', seq: number, at: number) {
    await queueIngress(groupId,async () => {
      if (running.has(groupId) || background.has(groupId)) return false
      const latest = await store.load(groupId)
      if (latest.bindingToken !== bindingToken || running.has(groupId) || background.has(groupId)) return false
      if ((latest[cursor]?.seq ?? 0) < seq) {
        latest[cursor] = {seq, at}
        await store.save(groupId, latest)
      }
      return true
    })
  }

  /** 按人口头禅挖掘：每群冷却（默认 6h），从归档挖"他说得多、别人基本不说"的专属词 */
  /** 人物核心档案提取（跨群身份级事实）：保守口径 + 冷却，空档时在 sweep 里跑 */
  async function maybeExtractPersonProfiles(groupId: string, state: SimSessionState, cfg: SimRuntimeConfig): Promise<void> {
    if (!cfg.personProfile.enabled || typeof ports.personProfileExtract !== 'function' || !state.botId) return
    if (running.has(groupId) || background.has(groupId) || pendingWakes.has(groupId) || ingressQueue.has(groupId)) return
    const at = now()
    const address = targetFor(groupId, state.botId)
    const target = Object.freeze({ ...address, account: Object.freeze({ ...address.account }) })
    const resolved = personaFor(target)
    const binding = resolved.binding ? Object.freeze({ ...resolved.binding, target }) : undefined
    const scope = characterScopeFor(target, resolved.personaId || 'default')
    const scene = { kind: 'group' as const, id: scope.groupId }
    const profileStore = scopedStore(scope, binding)
    const token = state.bindingToken
    const cursor = state.personProfileCursor
    if (cursor && at - cursor.at < cfg.personProfile.extractCooldownMs) return
    if (ports.isMemoryInputAvailable?.(target.account) === false) return
    const controller = new AbortController()
    let active = true, bindingCurrent = true, usageRecorded = false
    let activityVersion = '', memoryInvalidatedAt = 0
    let fresh: SimMessage[] = []
    let completedSeq: number | undefined
    let memoryTurn: Awaited<ReturnType<NonNullable<SimulationRuntimePorts['beginMemoryTurn']>>> | undefined
    const sourceStillPresent = (message: SimMessage) => state.recent.some(current =>
      current.seq === message.seq && current.messageId === message.messageId && current.userId === message.userId &&
      current.at === message.at && current.text === message.text && !current.forwardId && !current.textTruncated)
    const isCurrent = () => {
      try {
        if (!active || stopped || controller.signal.aborted || memoryTurn?.isCurrent() === false ||
            ports.isMemoryInputAvailable?.(target.account) === false || ports.isAccountReady?.(target.account) === false ||
            !handlesTarget(target) || ports.allowsSimulation?.(target) === false || !groupActive(runtimeConfig(), groupId) ||
            !runtimeConfig(groupId).personProfile.enabled) return false
        const live = personaFor(target)
        bindingCurrent = bindingCurrent && state.botId === target.account.id && state.bindingToken === token &&
          (live.personaId || 'default') === scope.personaId &&
          (live.binding ? agentBindingToken(live.binding) : undefined) === token
        return bindingCurrent && fresh.every(sourceStillPresent)
      } catch { return false }
    }
    if (!isCurrent()) return
    background.add(groupId)
    liveStates.set(groupId, state)
    backgroundControllers.add(controller)
    backgroundByGroup.set(groupId, controller)
    let rejectAbort!: (error: Error) => void
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
    // Always observe cancellation, including before an external callback is started.
    void aborted.catch(() => {})
    const abort = () => rejectAbort(new Error('人物事实提取已取消'))
    controller.signal.addEventListener('abort', abort, { once: true })
    const bounded = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, aborted])
    const cancelMemoryTurn = () => controller.abort()
    const timeout = setTimeout(() => controller.abort(), 60_000)
    const bindingPoll = setInterval(() => { if (!isCurrent()) controller.abort() }, 50)
    timeout.unref?.(); bindingPoll.unref?.()
    const assertCurrent = () => { if (!isCurrent()) throw new Error('人物事实提取范围已改变') }
    const ensureCurrent = () => bounded((async () => {
      assertCurrent()
      await refreshGroupState(true)
      if ((await characters.load(scope)).paused) throw new Error('人物事实提取所属角色已暂停')
      if (await store.loadActivityVersion(groupId) !== activityVersion ||
          (await personMemory.getSceneRedactions({ identity: scope, scene })).invalidatedAt !== memoryInvalidatedAt) {
        throw new Error('人物事实提取来源已改变')
      }
      if ((await redactSceneMessages(scope, fresh)).length !== fresh.length) throw new Error('人物事实提取来源已撤销')
      if (ports.isMessageRecalled && (await Promise.all(fresh.map(message =>
        ports.isMessageRecalled!(target, String(message.messageId))))).some(Boolean)) throw new Error('人物事实提取消息已撤回')
      assertCurrent()
    })())
    try {
      if (binding && ports.beginMemoryTurn) {
        const acquiredTurn = await bounded(ports.beginMemoryTurn(binding).then(turn => {
          if (!active || controller.signal.aborted) { turn.release(); throw new Error('人物事实提取已取消') }
          memoryTurn = turn
          return turn
        }))
        acquiredTurn.signal.addEventListener('abort', cancelMemoryTurn, { once: true })
        if (acquiredTurn.signal.aborted) controller.abort()
      }
      assertCurrent()
      memoryInvalidatedAt = (await personMemory.getSceneRedactions({ identity: scope, scene })).invalidatedAt
      activityVersion = await store.loadActivityVersion(groupId)
      fresh = (await redactSceneMessages(scope, state.recent)).filter(m => m.at > memoryInvalidatedAt &&
        m.seq > (cursor?.seq ?? Math.max(0, state.seq - 40)))
        .filter(m => m.kind === 'text' && !!m.text.trim() && m.messageId !== null && !m.forwardId && !m.textTruncated)
        .slice(-40).map(message => ({ ...message }))
      if (fresh.length < 20) return
      const startedAt = now()
      const context: PersonProfileExtractionContext = Object.freeze({ target, ...(binding ? { binding } : {}),
        signal: controller.signal, isCurrent, ensureCurrent,
        recordUsage(model: string, usage: unknown) {
          if (!active || usageRecorded) return
          usageRecorded = true
          try { ports.recordTokens?.({ scope: groupId, stage: 'person-profile', model, usage, ms: now() - startedAt }) } catch { /* 账本不可用 */ }
        },
      })
      const messages = Object.freeze(fresh.map(m => Object.freeze({ userId: m.userId, name: m.name, text: m.text })))
      await ensureCurrent()
      const raw = await bounded(Promise.resolve().then(() => {
        assertCurrent()
        return ports.personProfileExtract!(messages, isCurrent, context)
      }))
      if (!usageRecorded) {
        try { ports.recordTokens?.({ scope: groupId, stage: 'person-profile', ms: now() - startedAt }) } catch { /* 账本不可用 */ }
      }
      await ensureCurrent()
      if (typeof raw !== 'string' || raw.length > 64_000) throw new Error('人物事实提取结果无效')
      if (!Array.isArray(JSON.parse(raw))) throw new Error('人物事实提取结果不是数组')
      const patches = parsePersonProfilePatches(raw, isQqSimulationAddress(target) ? undefined : isSimulationUserId)
      let mergedCount = 0
      for (const patch of patches) {
        await ensureCurrent()
        const memories = (patch.entries || []).flatMap(entry => {
          const message = groundPersonProfileCandidate(patch, entry, fresh) as SimMessage | undefined
          if (!message || !sourceStillPresent(message)) return []
          return [{ text: entry.text, category: entry.category, source: { scene: { kind: 'group' as const, id: scope.groupId }, authorId: message.userId, messageId: String(message.messageId), at: message.at, excerpt: entry.sourceExcerpt },
            evidenceKind: 'self' as const, sensitivity: entry.sensitivity, portable: entry.portable, confidence: 0.8 }]
        })
        if (!memories.length) continue
        assertCurrent()
        await profileStore.mergePersonProfile(patch.userId, { memories }, cfg.personProfile.maxFields, isCurrent)
        mergedCount += memories.length
      }
      await ensureCurrent()
      completedSeq = fresh.at(-1)!.seq
      if (mergedCount > 0) logger.info(`[仿真] 群 ${groupId} 人物来源提取 ${mergedCount} 条（提取自 ${fresh.length} 条消息）`)
    } catch {
      logger.warn(`[仿真] 群 ${groupId} 人物事实提取未完成，已丢弃未提交结果`)
    } finally {
      let pending: SimWakeReason[] = []
      let finalSave: Promise<void> | undefined
      try {
        // Ingress shares this object while storage is pending. Keep ownership through
        // the handoff snapshot so a concurrent message or durable wake cannot be lost.
        await store.save(groupId, state)
        if (completedSeq !== undefined) {
          try {
            await ensureCurrent()
            state.personProfileCursor = { seq: completedSeq, at }
          } catch { /* Cancelled work must not advance the extraction cursor. */ }
        }
        pending = (bindingCurrent ? state.pendingWakeReasons : []).filter(reason => messageReasonStillPending(reason, state.unread))
        state.pendingWakeReasons = []
        const [first, ...rest] = pending
        const next = first && rest.reduce((best, reason) => mergeWakeReason(best, reason).reason, first)
        if (ports.durableIngress && next) {
          state.pendingWakeReasons = pending.filter(reason => reason !== next && isDirectAddressKind(reason.kind))
          pending = [queueWake(state, next)]
        }
        finalSave = store.save(groupId, state)
      } finally {
        active = false
        clearTimeout(timeout); clearInterval(bindingPoll)
        controller.signal.removeEventListener('abort', abort)
        memoryTurn?.signal.removeEventListener('abort', cancelMemoryTurn)
        memoryTurn?.release()
        controller.abort()
        backgroundControllers.delete(controller)
        backgroundByGroup.delete(groupId)
        background.delete(groupId)
        liveStates.delete(groupId)
        notifyWaiters(groupId)
      }
      await finalSave
      if (!stopped && pending.length) await scheduleWake(groupId, pending.reduce((a,b) => mergeWakeReason(a,b).reason), state.bindingToken, cfg)
    }
  }

  /** 健康哨兵：定期检查后台组件连环失败/过期，写 Redis 供控制台展示 */
  async function runHealthSentinel(): Promise<void> {
    try {
      const alerts: HealthAlert[] = []
      let commitmentFailures: { id?: string; intent?: string; group_id?: string; reason?: string; at?: number }[] | null = null
      try {
        const memory = await ports.readHealthStyleMemory?.()
        if (memory !== undefined) alerts.push(...checkHealth({ now: now(), styleMemory: memory }))
      } catch { /* 读不到就跳过 */ }
      try {
        const raw = await ports.redis.get('bl-chat:commitment:faillog')
        if (raw) {
          const parsed: unknown = JSON.parse(raw)
          if (Array.isArray(parsed)) commitmentFailures = parsed.filter(v => v !== null && typeof v === 'object')
        }
      } catch { /* 读不到就跳过 */ }
      alerts.push(...checkHealth({ now: now(), commitmentFailures }))
      // 写 Redis 供控制台展示
      const payload = JSON.stringify({ alerts, checkedAt: now() })
      try { await ports.redis.set('shiloh:health:alerts', payload) } catch { /* redis 不可用 */ }
      if (alerts.length) logger.warn(`[健康哨兵] ${formatAlerts(alerts)}`)
    } catch { /* 哨兵自身失败不影响主流程 */ }
  }

  /** 生活线同步：空闲时拉取真实更新（新集→记笔记），全局共享 */
  async function maybeSyncLifeThreads(cfg: SimRuntimeConfig, store: SimSessionStore, isCurrent: () => boolean): Promise<void> {
    if (!cfg.lifeThreads.enabled || typeof ports.lifeThreadSync !== 'function') return
    const threads = normalizeLifeThreads(await store.loadLifeThreads().catch(() => []))
    const at = now()
    let dirty = false
    for (const thread of threads) {
      if (!isCurrent()) return
      if (thread.status !== 'active') continue
      if (at - thread.lastSyncAt < cfg.lifeThreads.syncIntervalMs) continue
      try {
        const started = now()
        const result = await ports.lifeThreadSync({ sourceId: thread.sourceId, title: thread.title, ...(thread.lastEpisode ? { lastEpisode: thread.lastEpisode } : {}) })
        try { ports.recordTokens?.({ scope: 'life-thread', stage: 'sync', ms: now() - started }) } catch {}
        if (result && !('error' in result) && result.newNotes?.length) {
          Object.assign(thread, mergeThreadSync(thread, result, at))
          dirty = true
          logger.info(`[仿真] 生活线《${thread.title}》新增 ${result.newNotes.length} 条真实笔记`)
        }
      } catch { /* 单线失败不影响整批 */ }
    }
    if (dirty && isCurrent()) await store.saveLifeThreads(threads)
  }

  async function maybeMineUserStyle(groupId: string, cfg: SimRuntimeConfig): Promise<void> {
    if (!cfg.userStyle.enabled || typeof ports.readArchiveMessages !== 'function') return
    try {
      const session = await store.load(groupId), scope = boundScopeFor(groupId, session.botId)
      if (!scope || (await personMemory.getSceneRedactions({ identity: scope, scene: { kind: 'group', id: scope.groupId } })).invalidatedAt > 0) return
      const current = await store.loadUserStyle(groupId)
      if (now() - current.updatedAt < cfg.userStyle.cooldownMs) return
      // P0 反污染：机器人发言不进口头禅挖掘——学 AI 的口头禅只会更像机器
      const botIds = new Set(ports.getStyleBotUserIds?.() || [])
      const messages = (await ports.readArchiveMessages(groupId, cfg.userStyle.archiveDays)).filter(item => !botIds.has(String(item.userId || '')))
      if (messages.length < 50) return
      const catchphrases = mineUserCatchphrases(messages)
      const users: Record<string, string[]> = {}
      for (const item of catchphrases) users[item.userId] = item.words
      await store.saveUserStyle(groupId, users)
      if (Object.keys(users).length) logger.info(`[仿真] 群 ${groupId} 口头禅库更新：${Object.keys(users).length} 人`)
    } catch (error) {
      logger.warn(`[仿真] 群 ${groupId} 口头禅挖掘失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async function start() {
    stopped = false
    if (sweeper) return
    await refreshGroupState(true)
    // B4 断线宽限：重启=旧回合已死，清掉全部 busy 标记（否则 Redis 里的 15 分钟租约
    // 会让重启时有回合的群卡住——群友感觉希洛突然消失了一刻钟）
    try {
      const known = knownGroupsCache || []
      for (const groupId of known) {
        const address = decodeSimulationAddressKey(groupId)
        const target = address ?? targetFor(groupId, (await store.load(groupId)).botId || ports.getSelf().id)
        if (handlesTarget(target)) await store.clearBusy(groupId).catch(() => {})
      }
      if (known.length) logger.info(`[仿真] 启动清理：${known.length} 个群的旧回合租约已释放`)
    } catch { /* 清理失败不阻塞启动 */ }
    sweeper = setInterval(() => {
      void sweepOnce().catch(error => logger.error('[仿真] 调度检查失败', error))
    }, boundedTimerDelay(SIM_SWEEP_INTERVAL_MS, 3_600_000, 5_000))
    sweeper.unref?.()
    const cfg = runtimeConfig()
    const scope = !cfg.enabled ? '总开关关闭，全部群走普通模式'
      : cfg.allGroups ? '默认全部白名单群（.仿真 关 可按群退出）'
        : `显式清单 ${(overridesCache?.explicitEnabled || []).join(',') || '空'}`
    logger.info(`[仿真] 自主仿真模式已就绪（sweep ${SIM_SWEEP_INTERVAL_MS / 1000}s）：${scope}`)
  }

  function stop() {
    stopped = true
    for (const controller of fileTurnControllers) controller.abort()
    for (const controller of backgroundControllers) controller.abort()
    if (sweeper) { clearInterval(sweeper); sweeper = null }
    for (const [, pending] of pendingWakes) clearTimeout(pending.timer)
    pendingWakes.clear()
    for (const [, pending] of retryTimers) clearTimeout(pending.timer)
    retryTimers.clear()
    for (const groupId of waiters.keys()) notifyWaiters(groupId)
  }

  async function drain(): Promise<void> {
    await Promise.allSettled([...scheduledTurns, ...activeSweeps, ...ingressQueue.values(), ...commitmentRuns.values()])
  }

  /** 覆盖表结构演进时保住已有字段：启停群不能把预算覆盖弄丢 */
  function nextOverrides(edit: { explicitEnabled?: string[]; disabled?: string[]; atOnly?: string[]; playAlongUntil?: Record<string, number> }): SimGroupOverrides {
    const current = overridesCache || { explicitEnabled: [], disabled: [], budgetCaps: {}, turnCaps: {} }
    return {
      explicitEnabled: edit.explicitEnabled ?? [...(current.explicitEnabled || [])],
      disabled: edit.disabled ?? [...(current.disabled || [])],
      budgetCaps: { ...(current.budgetCaps || {}) },
      turnCaps: { ...(current.turnCaps || {}) },
      atOnly: edit.atOnly ?? [...(current.atOnly || [])],
      playAlongUntil: edit.playAlongUntil ?? { ...(current.playAlongUntil || {}) },
      ...(current.budgetDefaultCny !== undefined ? { budgetDefaultCny: current.budgetDefaultCny } : {}),
    }
  }

  /** 永久活跃档的到期哨兵值（2100-01-01）：活跃=长期生效，不自动回落 */
  const ACTIVE_FOREVER_MS = 4102444800000

  let rhythmCache: { at: number; win: RhythmWindow } | null = null
  async function loadRhythmWindow(cfg: SimRuntimeConfig, scope?: CharacterScope): Promise<RhythmWindow> {
    if (!scope && rhythmCache && now() - rhythmCache.at < 60_000) return rhythmCache.win
    const stored = await (scope ? scopedStore(scope) : store).loadRhythm().catch(() => null)
    const adminDefault = scope && !stored ? await store.loadRhythm().catch(() => null) : null
    const effective = stored ?? (adminDefault?.setBy === 'admin' ? adminDefault : null)
    const win = effective ? { sleepFrom: effective.sleepFrom, sleepTo: effective.sleepTo } : { sleepFrom: cfg.rhythm.sleepFrom, sleepTo: cfg.rhythm.sleepTo }
    if (!scope) rhythmCache = { at: now(), win }
    return win
  }

  /** 活跃助推是否生效（窗口未过期） */
  function playAlongActive(groupId: string): boolean {
    const until = Number(overridesCache?.playAlongUntil?.[groupId])
    return Number.isFinite(until) && until > now()
  }

  async function enableGroup(groupId: string): Promise<string> {
    await refreshGroupState(true)
    const cfg = runtimeConfig()
    const overrides = nextOverrides({ disabled: (overridesCache?.disabled || []).filter(g => g !== groupId) })
    if ((!cfg.allGroups || decodeSimulationAddressKey(groupId)) && !overrides.explicitEnabled.includes(groupId)) overrides.explicitEnabled.push(groupId)
    await store.saveOverrides(overrides)
    overridesCache = overrides
    return cfg.allGroups && !overrides.disabled.includes(groupId)
      ? `会话 ${displayConversation(groupId)} 确认处于仿真模式（当前默认全群开启，未单独退出过）`
      : `会话 ${displayConversation(groupId)} 已切换到仿真模式（下一条消息起生效）`
  }

  async function disableGroup(groupId: string): Promise<string> {
    backgroundByGroup.get(groupId)?.abort()
    await refreshGroupState(true)
    const overrides = nextOverrides({ explicitEnabled: (overridesCache?.explicitEnabled || []).filter(g => g !== groupId) })
    if (!overrides.disabled.includes(groupId)) overrides.disabled.push(groupId)
    await store.saveOverrides(overrides)
    overridesCache = overrides
    const pending = pendingWakes.get(groupId)
    if (pending) { clearTimeout(pending.timer); pendingWakes.delete(groupId) }
    return `会话 ${displayConversation(groupId)} 已切回普通模式（.仿真 开 可再切回）`
  }

  /** .仿真 模式 仅@/自主/活跃：按群回复模式（管理员设定，优先于 AI 自设触发器）。
   *  自主档的主动程度：自主=触发器命中才说；活跃=群里持续有动静时按节奏主动跟进（跑团当玩家）。
   *  mode 缺省=query。 */
  async function setGroupReplyMode(groupId: string, mode: 'atOnly' | 'auto' | 'active' | 'query' = 'query'): Promise<string> {
    await refreshGroupState(true)
    const atOnlyList = overridesCache?.atOnly || []
    const isAtOnly = atOnlyList.includes(groupId)
    const isBoosted = playAlongActive(groupId)
    const gapMin = Math.round(runtimeConfig().wake.playAlongGapMs / 60_000)
    if (mode === 'query') {
      if (isAtOnly) return `本群回复模式：仅被@才回（AI 仍在看全部消息，只有被@或引用时才说话；.仿真 模式 自主 可恢复）`
      if (isBoosted) {
        const until = Number(overridesCache?.playAlongUntil?.[groupId])
        const left = until >= ACTIVE_FOREVER_MS ? '长期' : `剩约 ${Math.max(1, Math.ceil((until - now()) / 60_000))} 分钟`
        return `本群回复模式：自主·活跃（${left}；群里持续有动静时每 ${gapMin} 分钟最多兜底跟进一次，AI 会同步收到自调引导）`
      }
      return `本群回复模式：自主（观察全部消息，触发器命中/@点名时说话；.仿真 模式 活跃 可切换为长期活跃档）`
    }
    const current = isAtOnly ? 'atOnly' : isBoosted ? 'active' : 'auto'
    if (mode === current) return `本群回复模式已是「${mode === 'atOnly' ? '仅被@才回' : mode === 'active' ? '自主·活跃' : '自主'}」，无需修改`
    const playAlongUntil = { ...(overridesCache?.playAlongUntil || {}) }
    if (mode === 'active') playAlongUntil[groupId] = ACTIVE_FOREVER_MS
    else delete playAlongUntil[groupId]
    const overrides = nextOverrides({
      atOnly: mode === 'atOnly' ? [...new Set([...atOnlyList, groupId])] : atOnlyList.filter(g => g !== groupId),
      playAlongUntil,
    })
    await store.saveOverrides(overrides)
    overridesCache = overrides
    if (mode === 'atOnly') {
      backgroundByGroup.get(groupId)?.abort()
      // 切到仅@时，已排期的自主类唤醒立即取消，避免切换后还突然冒一次泡
      const pending = pendingWakes.get(groupId)
      if (pending && !AT_ONLY_WAKE_KINDS.has(pending.reason.kind)) { clearTimeout(pending.timer); pendingWakes.delete(groupId) }
      return `会话 ${displayConversation(groupId)} 已设为「仅被@才回」：消息照常看、照常记忆，但只有被@或引用时才说话（.仿真 模式 自主 可恢复）`
    }
    if (mode === 'active') {
      return `会话 ${displayConversation(groupId)} 已设为「自主·活跃」（长期生效）：群里持续有动静时每 ${gapMin} 分钟最多兜底跟进一次，AI 会同步用 simSetWakeConfig 调自己的触发器；.仿真 模式 自主 可调回（跑团若开了骰娘 log，记得 .骰娘 跑团AI 开）`
    }
    return `会话 ${displayConversation(groupId)} 已设为「自主」：观察全部消息，触发器命中/@点名时说话（.仿真 模式 活跃 可再开助推）`
  }

  async function groupStatus(groupId: string): Promise<string> {
    await refreshGroupState(true)
    const cfg = runtimeConfig(groupId)
    const active = groupActive(cfg, groupId)
    const live = liveStates.get(groupId)
    const state = live ?? await store.load(groupId)
    const at = now()
    const { carriedTurns } = await groupBudgetUsage(groupId, at)
    rollBudgetDay(state, at)
    const moodSummary = cfg.mood.enabled
      ? moodSummaryLine(normalizeSimMood(await store.loadMood().catch(() => null), now()), now(), cfg.mood.halfLifeMs)
      : ''
    return [
      `模式：${active ? '仿真（AI 自主收发）' : '普通'}${running.has(groupId) ? '（回合进行中）' : ''}`,
      `回复模式：${(overridesCache?.atOnly || []).includes(groupId) ? '仅被@才回（管理员设定，优先于 AI 自设触发器）' : playAlongActive(groupId) ? (Number(overridesCache?.playAlongUntil?.[groupId]) >= 4102444800000 ? '自主·活跃（长期）' : `自主·活跃（剩 ${Math.max(1, Math.ceil((Number(overridesCache?.playAlongUntil?.[groupId]) - now()) / 60_000))} 分钟）`) : '自主'}`,
      `范围：${cfg.enabled ? (cfg.allGroups ? '默认全群开启，可按群 .仿真 关' : '仅显式清单') : '总开关关闭'}`,
      `唤醒配置：mode=${state.wakeConfig.mode}${state.wakeConfig.sleepUntil ? `（${Math.max(0, Math.ceil((state.wakeConfig.sleepUntil - now()) / 60_000))} 分钟后到期）` : ''}`,
      `触发器：${JSON.stringify(state.wakeConfig.triggers)}`,
      `水位：lastReadThrough=${state.lastReadThroughSeq} unread=${state.unread.length} recent=${state.recent.length}`,
      `今日：${state.budget.turns + carriedTurns}/${cfg.turn.groups[groupId] ?? cfg.turn.maxTurnsPerDay} 回合，${state.budget.tokens} tokens`,
      `最近唤醒：${state.lastWakeReason?.kind || '无'}（${state.lastWakeAt ? Math.round((now() - state.lastWakeAt) / 1000) + ' 秒前' : '从未'}）`,
      `最近发言：${state.lastAiSendAt ? Math.round((now() - state.lastAiSendAt) / 1000) + ' 秒前' : '未发言'}`,
      ...(moodSummary ? [`情绪底色（跨群全局）：${moodSummary}`] : []),
      `回合历史：${state.agentHistory.length} 条`,
    ].join('\n')
  }

  async function resetGroup(groupId: string): Promise<string> {
    return await queueIngress(groupId, async () => {
      if (background.has(groupId)) return '后台角色活动进行中，请暂停自主行动并稍后重试重置'
      if (running.has(groupId)) return '该群有仿真回合正在进行，请稍后再重置'
      const cfg = runtimeConfig()
      const previous = await store.load(groupId)
      const reset = createDefaultSimSession(now(), cfg.agentPresetKeywords)
      reset.bootstrapSent = true
      // Evidence uses message:seq; a session reset must never reuse an old source identifier.
      reset.seq = previous.seq
      reset.lastReadThroughSeq = previous.seq
      if (previous.botId) reset.botId = previous.botId
      if (previous.personaId) reset.personaId = previous.personaId
      if (previous.bindingToken) reset.bindingToken = previous.bindingToken
      const binding = initialPromptStore ? initialPromptBinding(groupId) : undefined
      if (binding?.source !== 'configured' || !await initialPromptStore?.resetAndRearm(groupId, binding, { key: simulationSessionKey(groupId), value: JSON.stringify(reset) })) {
        await store.save(groupId, reset)
      }
      return `会话 ${displayConversation(groupId)} 已重置（历史/水位/预算清空，启用状态保留；长期记忆与好感度不受影响）`
    })
  }

  /** A3 撤回：从 unread/recent 移除对应消息，水位只增不减 */
  async function handleRecall(e: { group_id?: string | number; message_id?: string | number }, target?: ConversationAddress): Promise<boolean> {
    if (target && e.group_id != null && String(e.group_id) !== target.id) return false
    const groupId = target
      ? (ports.durableIngress ? simulationAddressKey(target) : await conversationKey(target))
      : String(e.group_id || '')
    const messageId = String(e.message_id ?? '')
    if (!groupId || !messageId || (target && !handlesTarget(target))) return false
    return queueIngress(groupId, () => recallInGroup(groupId, messageId, target))
  }

  async function recallInGroup(groupId: string, messageId: string, addressed?: ConversationAddress): Promise<boolean> {
    await refreshGroupState()
    if (!ports.durableIngress && !groupActive(runtimeConfig(), groupId)) return false
    let state = liveStates.get(groupId) ?? await store.load(groupId)
    if (addressed && state.botId !== addressed.account.id && (!ports.durableIngress || state.botId)) return false
    backgroundByGroup.get(groupId)?.abort()
    await store.invalidateActivity(groupId)
    if (ports.durableIngress && (addressed || state.botId)) {
      const target = addressed ?? targetFor(groupId, state.botId ?? '')
      const { botId, scene } = personMemoryAddress(target)
      await revokePersonMemorySourceForAccount(personMemory, botId, scene, messageId, state.botId ? state.personaId || 'default' : undefined)
    } else {
      const scope = boundScopeFor(groupId, state.botId)
      if (scope) await scopedStore(scope).revokePersonSource(messageId)
    }
    if (addressed && !state.botId) return true
    state = liveStates.get(groupId) ?? await store.load(groupId)
    state.agentHistory = []
    delete state.lastConfirmedChat
    const quoteOnlySeqs = new Set([...state.recent, ...state.unread].filter(message => message.quoteSource?.messageId === messageId &&
      needsQuoteForWake(message)).map(message => message.seq))
    const removeMsg = (list: SimMessage[]) => list.filter(m => String(m.messageId ?? '') !== messageId)
      .map(message => message.quoteSource?.messageId === messageId ? withoutResolvedQuote(message) : message)
    const beforeUnread = state.unread.length
    const beforeRecent = state.recent.length
    state.unread = removeMsg(state.unread)
    state.recent = removeMsg(state.recent)
    if (state.confirmedMessageIds?.includes(messageId)) state.confirmedMessageIds = state.confirmedMessageIds.filter(id => id !== messageId)
    const visibleSeqs = new Set([...state.unread, ...state.recent].map(message => message.seq))
    const sourceExists = (reason: SimWakeReason) => reason.seq === undefined ||
      (visibleSeqs.has(reason.seq) && (reason.kind !== 'atMention' || !quoteOnlySeqs.has(reason.seq)))
    state.pendingWakeReasons = state.pendingWakeReasons.filter(sourceExists)
    if (state.queuedIngressWake && !sourceExists(state.queuedIngressWake)) delete state.queuedIngressWake
    const pending = pendingWakes.get(groupId)
    if (pending && !sourceExists(pending.reason)) {
      clearTimeout(pending.timer)
      pendingWakes.delete(groupId)
    }
    await store.save(groupId, state)
    if (state.unread.length < beforeUnread || state.recent.length < beforeRecent) {
      logger.info(`[仿真] 群 ${groupId} 消息已撤回（messageId=${messageId.slice(0, 12)}），从未读/近期中移除`)
    }
    return true
  }

  /** 戳一戳入流：被戳 = 一条 kind='poke' 消息 + triggers.poke 唤醒（qq-bridge 的拍一拍机制） */
  async function ingestPoke(e: { group_id?: string | number; user_id?: string | number; self_id?: string | number; target_id?: string | number; sender?: { nickname?: string; card?: string } }, target?: ConversationAddress): Promise<boolean> {
    const id = String(e.group_id || '')
    const route = target ?? (id ? qqSimulationAddress(id, ports.getSelf(e.self_id).id) : null)
    if (!route || !isQqSimulationAddress(route) || route.id !== id || (e.self_id != null && String(e.self_id) !== route.account.id)
      || (e.target_id !== undefined && String(e.target_id) !== route.account.id)) return false
    const senderId = String(e.user_id ?? '')
    const senderName = e.sender?.card || e.sender?.nickname
    return ingestNudge({
      kind: 'nudge', target: route, sender: { ...route.account, id: senderId },
      ...(senderName ? { senderName } : {}), occurredAt: now(),
    })
  }

  async function ingestNudge(event: PlatformNudgeEvent, options?: NudgeIngressOptions): Promise<boolean> {
    const { target, sender } = event
    if (!handlesTarget(target) || ports.getSection().enabled === false || !isSimulationUserId(sender.id) || !Number.isSafeInteger(event.occurredAt) || event.occurredAt <= 0
      || sender.platform !== target.account.platform || sender.namespace !== target.account.namespace) return false
    const groupId = await conversationKey(target)
    if (!groupId) {
      await refreshGroupState()
      return isQqSimulationAddress(target) && isSimulationGroup(target.id)
    }
    return queueIngress(groupId, () => ingestNudgeInGroup(groupId, event, options))
  }

  async function ingestNudgeInGroup(groupId: string, { target, sender, senderName, occurredAt }: PlatformNudgeEvent, options?: NudgeIngressOptions): Promise<boolean> {
    await refreshGroupState()
    const self = selfFor(target)
    if (self.id !== target.account.id || sender.id === (self.userId ?? self.id)) return false
    if (!groupActive(runtimeConfig(), groupId)) return false
    if (options?.isCurrent?.() === false) return true
    let binding: AgentBindingSnapshot | undefined
    try { binding = personaFor(target).binding } catch {
      logger.warn(`[仿真] 群 ${groupId} 角色绑定无效，跳过本次戳一戳`)
      return true
    }
    const bindingToken = binding ? agentBindingToken(binding) : undefined
    if (options?.binding && (conversationAddressKey(options.binding.target) !== conversationAddressKey(target)
      || agentBindingToken(options.binding) !== bindingToken)) return true
    const bindingCurrent = () => {
      try {
        const live = personaFor(target).binding
        return options?.isCurrent?.() !== false && (live ? agentBindingToken(live) : undefined) === bindingToken
      } catch { return false }
    }
    const state = await sessionForIncoming(groupId, self.id, bindingToken, bindingCurrent)
    if (!state || !bindingCurrent() || !isSimulationGroup(groupId)) return true
    const ingressId = options?.ingressId
    if (ports.durableIngress) {
      if (!ingressId) throw new Error('持久化互动缺少收件标识')
      await store.addKnownGroup(groupId)
      if (!bindingCurrent() || !isSimulationGroup(groupId)) return true
      if (state.recent.some(message => message.ingressId === ingressId)) return true
    }
    const cfg = runtimeConfig()
    alignSessionBinding(state, binding)
    state.botId = self.id
    state.seq += 1
    const message: SimMessage = {
      seq: state.seq,
      messageId: null,
      ...(ingressId ? { ingressId } : {}),
      userId: sender.id,
      name: senderName || sender.id,
      text: '（戳了戳你）',
      at: occurredAt,
      atSelf: true,
      quoteToSelf: false,
      imageCount: 0,
      kind: 'poke',
    }
    state.unread.push(message)
    if (state.unread.length > cfg.turn.unreadLimit) state.unread = state.unread.slice(-cfg.turn.unreadLimit)
    state.recent.push(message)
    if (state.recent.length > SIM_RECENT_LIMIT) state.recent = state.recent.slice(-SIM_RECENT_LIMIT)
    state.lastIncomingAt = Math.max(state.lastIncomingAt, message.at)
    resetPreSleepWait(state)
    const reason: SimWakeReason | null = state.wakeConfig.triggers.poke ? { kind: 'atMention', seq: message.seq } : null
    await saveIncoming(groupId, state, message, reason, bindingToken, cfg)
    return true
  }

  async function overview(): Promise<Record<string, unknown>> {
    await refreshGroupState(true)
    const cfg = runtimeConfig()
    const known = knownGroupsCache.filter(groupId => {
      const target = decodeSimulationAddressKey(groupId)
      return !target || handlesTarget(target)
    })
    const groups: Record<string, unknown>[] = []
    for (const groupId of known.slice(0, 60)) {
      try { groups.push(await describeGroup(groupId)) } catch { /* 单群失败不影响总览 */ }
    }
    return { enabled: cfg.enabled, allGroups: cfg.allGroups, disabled: overridesCache?.disabled || [], explicitEnabled: overridesCache?.explicitEnabled || [], budgetDefaultCny: cfg.budget.dailyCostCny, budgetGroupsCny: cfg.budget.groups, groups }
  }

  /** 控制台 JSON 视图 */
  async function describeGroup(groupId: string): Promise<Record<string, unknown>> {
    await refreshGroupState(true)
    const cfg = runtimeConfig(groupId)
    const state = await store.load(groupId)
    const at = now()
    const { carriedTurns, todayCostCny } = await groupBudgetUsage(groupId, at)
    rollBudgetDay(state, at)
    const scopedAddress = decodeSimulationAddressKey(groupId)
    const target = scopedAddress ?? (state.botId ? qqSimulationAddress(groupId, state.botId) : null)
    const scope = boundScopeFor(groupId, state.botId)
    if (scope) {
      await revokeSharedDerived(groupId, scope)
      const current = await characters.load(scope)
      await workspaceFor(scope).pruneEvidence([...activeCharacterMemories(current).map(memory => `memory:${memory.id}`), ...current.receipts.map(receipt => `receipt:${receipt.id}`)])
    }
    const memories = await sceneMemories(groupId)
    const memes = memories.filter(m => m.kind === 'meme' && !m.done).sort((a, b) => (b.count || 1) - (a.count || 1)).slice(0, 10)
    const affinity = await (scopedAddress && scope ? scopedStore(scope) : store).loadAffinity(groupId)
    const affinityList = Object.entries(affinity)
      .map(([userId, value]) => ({ userId, score: Math.max(0, Math.min(100, Math.floor(Number(record(value).score ?? 50)))) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
    return {
      groupId,
      ...(target ? { conversation: target } : {}),
      active: groupActive(cfg, groupId),
      running: running.has(groupId) || background.has(groupId),
      enabled: cfg.enabled,
      allGroups: cfg.allGroups,
      mode: state.wakeConfig.mode,
      /** 管理员设定的回复模式（三档）：atOnly=仅被@才回，active=自主·活跃，auto=自主 */
      replyMode: (overridesCache?.atOnly || []).includes(groupId) ? 'atOnly' : playAlongActive(groupId) ? 'active' : 'auto',
      wakeConfig: state.wakeConfig,
      unreadCount: state.unread.length,
      recentCount: state.recent.length,
      lastReadThroughSeq: state.lastReadThroughSeq,
      budget: { ...state.budget, turns: state.budget.turns + carriedTurns, maxTurnsPerDay: cfg.turn.groups[groupId] ?? cfg.turn.maxTurnsPerDay, turnsCapOverridden: Boolean(overridesCache?.turnCaps?.[groupId]), dailyCostCny: cfg.budget.groups[groupId] ?? cfg.budget.dailyCostCny, capOverridden: Boolean(overridesCache?.budgetCaps?.[groupId]), todayCostCny },
      lastWakeReason: state.lastWakeReason?.kind || null,
      lastWakeAtAgo: state.lastWakeAt ? Math.round((now() - state.lastWakeAt) / 1000) : null,
      lastAiSendAtAgo: state.lastAiSendAt ? Math.round((now() - state.lastAiSendAt) / 1000) : null,
      historyLength: state.agentHistory.length,
      initialPrompt: await store.getInitPrompt(groupId),
      pendingEvents: memories.filter(m => m.kind === 'pendingEvent' && !m.done).slice(0, 10).map(m => ({ id: m.id, content: m.content, dueAt: m.dueAt })),
      memes: memes.map(m => ({ id: m.id, content: m.content, count: m.count || 1, origin: m.origin || '' })),
      affinity: affinityList,
      characterBinding: scope
        ? { status: 'bound', botId: target?.account.id ?? scope.botId, personaId: scope.personaId }
        : { status: 'pending', botId: null, personaId: null, reason: '等待机器人收到本群消息后绑定角色' },
      character: scope ? await characters.load(scope) : null,
      activities: scope ? {
        works: await workspaceFor(scope).list(), subscriptions: await subscriptionsFor(scope).list(),
        reflection: await reflectionFor(scope).read(), shared: await sharedFor(scope).projection(), sharedPending: await sharedFor(scope).pending(),
        capabilities: [
          { name: '作品空间', description: '本群草稿、版本、恢复与来源撤销；分享须走发送工具', available: true },
          { name: '公开兴趣订阅', description: 'RSS、Atom、GitHub releases；有界轮询与更新去重', available: true },
          { name: '独立反思', description: '至少六小时一次、每日最多两次，受群预算与参与边界约束', available: !!ports.reflectCharacter && ports.getSection().reflection?.enabled !== false },
          { name: '跨群自我偏好', description: '只共享主人批准的角色观点/兴趣，来源撤销时失效', available: true },
          { name: '外部工作器', description: '可配置研究、图片或浏览器网关，受任务协议、超时、取消与真实回执约束', available: !!ports.runCharacterWorker && ports.characterWorkerAvailable?.() !== false },
          ...resolveExtraTools(resolveExtraToolNames(runtimeConfig(),groupId)).map(tool => ({ name: tool.name, description: (tool.description || '').slice(0,160), available: ports.isExtraToolAutonomous?.(tool.name) !== false && (AUTONOMOUS_EXTRA_TOOLS.includes(tool.name) || (AUTONOMOUS_CREATIVE_TOOLS.includes(tool.name) && Array.isArray(ports.getSection().autonomousTools) && ports.getSection().autonomousTools!.includes(tool.name))) })),
        ],
      } : { works: [], subscriptions: [], reflection: null, shared: [], sharedPending: [], capabilities: [] },
    }
  }

  async function controlCharacter(groupId: string, action: 'pause' | 'resume' | 'cancel-goal' | 'pause-goal' | 'resume-goal' | 'delete-memory', id?: string): Promise<string> {
    if (!/^\d{5,12}$/.test(groupId) && !decodeSimulationAddressKey(groupId)) throw new Error('仿真会话地址无效')
    const state = await store.load(groupId)
    const scope = boundScopeFor(groupId, state.botId)
    if (!scope) throw new Error('本群尚未绑定机器人，请等待机器人收到本群消息后再管理角色')
    if (action === 'pause' || action === 'delete-memory') backgroundByGroup.get(groupId)?.abort()
    if (action === 'delete-memory') await store.invalidateActivity(groupId)
    await characters.update(scope, current => {
      if (action === 'pause' || action === 'resume') return setCharacterPaused(current, action === 'pause', now())
      if (!id) throw new Error('缺少记录标识')
      if (action === 'delete-memory') return deleteCharacterMemory(current, id, now())
      return transitionCharacterGoal(current, id, action === 'cancel-goal' ? 'abandoned' : action === 'pause-goal' ? 'paused' : 'active', { now: now(), lastOutcome: '管理员调整目标状态' })
    })
    if (action === 'delete-memory') {
      const live = liveStates.get(groupId)
      if (live) {
        live.agentHistory = []
        await store.save(groupId, live)
      }
      const updated = await characters.load(scope)
      await workspaceFor(scope).pruneEvidence([...activeCharacterMemories(updated).map(m => `memory:${m.id}`), ...updated.receipts.map(r => `receipt:${r.id}`)])
      await revokeSharedDerived(groupId, scope)
      // A turn may have started after the first invalidation but before the
      // source deletion completed. Invalidate that intermediate view as well.
      await store.invalidateActivity(groupId)
    }
    return '角色状态已更新'
  }

  async function controlActivity(groupId: string, action: CharacterActivityOperation, id?: string, payload?: Record<string, unknown>): Promise<string> {
    if (!/^\d{5,12}$/.test(groupId) && !decodeSimulationAddressKey(groupId)) throw new Error('仿真会话地址无效')
    const session = await store.load(groupId), scope = boundScopeFor(groupId, session.botId)
    if (!scope) throw new Error('本群尚未绑定机器人，请等待机器人收到本群消息后再管理角色活动')
    if (action !== 'reflection-reset' && (!id || id.trim() !== id || id.length > 200)) throw new Error('缺少有效记录标识')
    const workspace = workspaceFor(scope), subscriptions = subscriptionsFor(scope), shared = sharedFor(scope)
    if (['work-delete','shared-delete','shared-approve'].includes(action)) {
      // Revoke before changing the source so an in-flight action cannot use it
      // between the source update and the shared cancellation becoming visible.
      await store.invalidateActivity(groupId)
      const live = liveStates.get(groupId)
      if (live) live.agentHistory = []
    }
    if (action === 'work-archive') await workspace.archive(id!, true)
    else if (action === 'work-delete') await workspace.remove(id!)
    else if (action === 'work-restore') {
      const current = await workspace.read(id!)
      await workspace.restore(id!, Number(payload?.revision), current.revision)
    } else if (action === 'subscription-pause' || action === 'subscription-resume') await subscriptions.pause(id!, action === 'subscription-pause')
    else if (action === 'subscription-remove') await subscriptions.remove(id!)
    else if (action === 'shared-approve') await shared.approve(id!)
    else if (action === 'shared-delete') await shared.remove(id!)
    else if (action === 'reflection-reset') await reflectionFor(scope).reset()
    else throw new Error('未知角色活动操作')
    // Do not save the console's session snapshot here: its runtime may be a
    // separate process. The shared version clears stale history on next use.
    await revokeSharedDerived(groupId, scope)
    if (['work-delete','shared-delete','shared-approve'].includes(action)) await store.invalidateActivity(groupId)
    return '角色活动已更新'
  }

  async function getInitialPrompt(groupId: string): Promise<string> {
    return await store.getInitPrompt(groupId)
  }

  function initialPromptBinding(groupId: string): AgentBindingSnapshot | undefined {
    const target = decodeSimulationAddressKey(groupId)
    if (!target || !handlesTarget(target)) return undefined
    try { return personaFor(target).binding } catch { return undefined }
  }

  async function setInitialPrompt(groupId: string, text: string): Promise<string> {
    if (initialPromptStore) {
      const binding = initialPromptBinding(groupId)
      if (binding?.source !== 'configured') throw new Error('独立仿真初始提示词需要有效的会话绑定')
      await initialPromptStore.edit(groupId, text, binding)
    } else await store.setInitPrompt(groupId, text)
    return text.trim() ? '初始提示词已保存（下次该群会话重置后的首次唤醒生效）' : '初始提示词已清空'
  }

  async function setGroupBudget(groupId: string, cap: number): Promise<string> {
    if (!/^\d{5,12}$/.test(groupId) && !decodeSimulationAddressKey(groupId)) return '仿真会话地址无效'
    await refreshGroupState(true)
    const overrides = { ...(overridesCache || { explicitEnabled: [], disabled: [], budgetCaps: {}, turnCaps: {} }) }
    overrides.turnCaps = { ...(overrides.turnCaps || {}) }
    overrides.budgetCaps = { ...(overrides.budgetCaps || {}) }
    const value = Math.floor(Number(cap) * 100) / 100
    if (value === -1) {
      overrides.budgetCaps[groupId] = -1
      await store.saveOverrides(overrides)
      overridesCache = overrides
      return `群 ${groupId} 每日消耗上限已设为不限`
    }
    if (Number.isFinite(value) && value > 0) {
      overrides.budgetCaps[groupId] = Math.min(10_000, value)
      await store.saveOverrides(overrides)
      overridesCache = overrides
      return `群 ${groupId} 每日消耗上限已设为 ${overrides.budgetCaps[groupId]} 元`
    }
    delete overrides.budgetCaps[groupId]
    await store.saveOverrides(overrides)
    overridesCache = overrides
    return `群 ${groupId} 已清除按群上限，回落到默认配置`
  }

  async function setGroupTurnsCap(groupId: string, cap: number): Promise<string> {
    if (!/^\d{5,12}$/.test(groupId) && !decodeSimulationAddressKey(groupId)) return '仿真会话地址无效'
    await refreshGroupState(true)
    const overrides = { ...(overridesCache || { explicitEnabled: [], disabled: [], budgetCaps: {}, turnCaps: {} }) }
    overrides.budgetCaps = { ...(overrides.budgetCaps || {}) }
    overrides.turnCaps = { ...(overrides.turnCaps || {}) }
    const value = Math.floor(Number(cap))
    if (value === -1) {
      overrides.turnCaps[groupId] = -1
      await store.saveOverrides(overrides)
      overridesCache = overrides
      return `群 ${groupId} 每日回合上限已设为不限`
    }
    if (Number.isFinite(value) && value > 0) {
      overrides.turnCaps[groupId] = Math.min(10_000, value)
      await store.saveOverrides(overrides)
      overridesCache = overrides
      return `群 ${groupId} 每日回合上限已设为 ${overrides.turnCaps[groupId]}`
    }
    delete overrides.turnCaps[groupId]
    await store.saveOverrides(overrides)
    overridesCache = overrides
    return `群 ${groupId} 已清除按群回合上限，回落到默认配置`
  }

  async function setDefaultBudget(cny: number): Promise<string> {
    await refreshGroupState(true)
    const overrides = { ...(overridesCache || { explicitEnabled: [], disabled: [], budgetCaps: {}, turnCaps: {} }) }
    overrides.turnCaps = { ...(overrides.turnCaps || {}) }
    const value = Math.floor(Number(cny) * 100) / 100
    if (Number.isFinite(value) && value > 0) {
      overrides.budgetDefaultCny = Math.min(10_000, value)
      await store.saveOverrides(overrides)
      overridesCache = overrides
      return `默认每日消耗上限已设为 ${overrides.budgetDefaultCny} 元`
    }
    delete overrides.budgetDefaultCny
    await store.saveOverrides(overrides)
    overridesCache = overrides
    return '已恢复使用配置文件的默认每日消耗上限'
  }

  async function listMemories(groupId: string): Promise<string> {
    const memories = await sceneMemories(groupId)
    const due = new Set(dueMemories(memories, now()).map(m => m.id))
    const lines = memories
      .filter(m => !m.done)
      .slice(-20)
      .reverse()
      .map(m => {
        const state = m.kind === 'pendingEvent' && m.dueAt
          ? (due.has(m.id) ? '【已到期】' : `【${Math.max(0, Math.round((m.dueAt - now()) / 60000))}分钟后】`)
          : m.kind === 'impression' ? '【印象】'
            : m.kind === 'meme' ? `【梗×${m.count || 1}】`
              : '【记事】'
        return `${state}${m.content}${m.aboutUser ? `（关于 ${m.aboutUser}）` : ''}${m.origin && m.kind === 'meme' ? `（${m.origin}）` : ''} [${m.id}]`
      })
    return lines.length ? `【仿真记忆 · 本群】\n${lines.join('\n')}` : '本群还没有仿真记忆。'
  }

  async function listAffinity(groupId: string, askerId?: string): Promise<string> {
    const session = await store.load(groupId), scope = boundScopeFor(groupId, session.botId)
    const raw = scope ? await scopedStore(scope).loadAffinity(groupId) : {}
    const entries = Object.entries(raw)
      .map(([userId, value]) => {
        const entry = record(value) as Partial<SimAffinityEntry>
        return { userId, score: Math.max(0, Math.min(100, Math.floor(Number(entry.score ?? 50)))), reasons: Array.isArray(entry.reasons) ? entry.reasons.map(String) : [] }
      })
      .sort((a, b) => b.score - a.score)
    if (!entries.length) return '本群还没有好感度记录（AI 会在互动中慢慢积累）。'
    const top = entries.slice(0, 8).map(e => `${e.userId}：${e.score}（${affinityLevel(e.score)}）`).join('\n')
    const mine = askerId ? entries.find(e => e.userId === String(askerId)) : undefined
    const mineLine = mine ? `\n\n你（${askerId}）：${mine.score}（${affinityLevel(mine.score)}）${mine.reasons[0] ? `，最近：${mine.reasons[0]}` : ''}` : ''
    return `【群友好感 · 前8】\n${top}${mineLine}`
  }

  return { ingest, ingestNudge, start, stop, drain, sweepOnce, enableGroup, disableGroup, setGroupReplyMode, groupStatus, resetGroup, listMemories, listAffinity, ingestPoke, handleRecall, overview, describeGroup, controlCharacter, controlActivity, getInitialPrompt, setInitialPrompt, setGroupBudget, setGroupTurnsCap, setDefaultBudget, conversationKey, isGroupActive: isSimulationGroup, isConversationActive, groupTextBudget, wakeForCommitment, listPersonProfiles: () => store.listPersonProfiles(), deletePersonProfile: (userId: string) => store.deletePersonProfile(userId), deletePersonProfileField: (userId: string, field: string, value?: string) => store.deletePersonProfileField(userId, field, value),
  lifeOverview: async () => {
    const cfg = runtimeConfig()
    const stored = await store.loadRhythm().catch(() => null)
    const rhythm = stored?.setBy === 'admin' ? { sleepFrom: stored.sleepFrom, sleepTo: stored.sleepTo, setBy: 'admin' } : { sleepFrom: cfg.rhythm.sleepFrom, sleepTo: cfg.rhythm.sleepTo }
    await refreshGroupState(true)
    const threads = (await Promise.all(knownGroupsCache.map(async groupId => {
      const state = await store.load(groupId)
      const scope = boundScopeFor(groupId, state.botId)
      if (!scope) return []
      return normalizeLifeThreads(await scopedStore(scope).loadLifeThreads()).map(thread => ({ ...thread, groupId }))
    }))).flat()
    const hour = new Date(now() + 8 * 3600_000).getUTCHours()
    return { rhythm, threads, now: { hour, sleeping: isSleeping(hour, { sleepFrom: rhythm.sleepFrom, sleepTo: rhythm.sleepTo }) } }
  },
  getHealthAlerts: async () => {
      try {
        const raw = await ports.redis.get('shiloh:health:alerts')
        return raw ? JSON.parse(raw) : { alerts: [], checkedAt: 0 }
      } catch { return { alerts: [], checkedAt: 0 } }
    },
    setLifeRhythm: async (from: number, to: number) => {
    await store.saveRhythm({ sleepFrom: from, sleepTo: to, setBy: 'admin' })
    await refreshGroupState(true)
    for (const groupId of knownGroupsCache) {
      const state = await store.load(groupId)
      const scope = boundScopeFor(groupId, state.botId)
      if (!scope) continue
      await scopedStore(scope).saveRhythm({ sleepFrom: from, sleepTo: to, setBy: 'admin' })
    }
    rhythmCache = null
    return `已设定作息 ${from}:00 - ${to}:00（页面设定）`
  } }
}
