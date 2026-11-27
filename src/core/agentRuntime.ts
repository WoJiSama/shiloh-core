import type { AgentBilibiliQualityConfig, AgentBilibiliQualityProvider } from '../contracts/agentBilibiliQuality.js'
import type { AgentBilibiliAuthService } from '../contracts/agentBilibiliAuth.js'
import { createAgentBilibiliQualityWorkflow, isAgentBilibiliQualityCommand, validateAgentBilibiliQualityConfig } from '../modules/media/infrastructure/agentBilibiliQualityWorkflow.js'
import { createHash } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { AgentManagementError, type AgentManagementBindings, type AgentManagementContext, type AgentManagementModules } from '../contracts/agentManagement.js'
import { createAgentProfileManagement } from '../modules/memory/infrastructure/agentProfileManagement.js'
import { createAgentTrusteeshipManagement } from '../modules/commitments/infrastructure/agentTrusteeshipManagement.js'
import { captureSynchronousGuardCheck, createSynchronousGuard } from '../modules/runtime/domain/synchronousGuard.js'
import { createAgentToolSourceGuard } from '../modules/runtime/infrastructure/agentToolSourceGuard.js'
import type { AgentFileBytes, AgentFileListing, AgentFileRequest } from '../contracts/agentFiles.js'
import type { AgentFileUpload, FileDeliveryReceipt } from '../contracts/agentFileDelivery.js'
import type { AgentAudioBytes, AgentVideoBytes, SendMediaAction } from '../contracts/agentMedia.js'
import type { AgentVideoInput } from '../contracts/agentVideo.js'
import type { AgentInteraction, AgentInteractionPlan, AgentInteractionResult } from '../contracts/agentInteraction.js'
import { createAgentInteractionWorkflow, normalizeInteractionReceipt } from '../modules/tools/infrastructure/agentInteractions.js'
import { createAgentInteractionTools } from '../modules/tools/infrastructure/agentInteractionTools.js'
import { createAgentOutboundMessages } from '../modules/runtime/infrastructure/agentOutboundMessages.js'
import { canApplyGroupManagement, isAgentGroupManagement } from '../modules/tools/domain/agentGroupManagement.js'
import type { AgentMusicCard } from '../contracts/agentMusic.js'
import type { AgentAudioAttachment, AgentMusicExtractionConfig } from '../contracts/agentMusicExtraction.js'
import type { AgentMediaRelayConfig, AgentMediaRelayProvider, AgentMediaShare } from '../contracts/agentMediaRelayWorkflow.js'
import type { AgentMediaRelayPlan } from '../contracts/agentMediaRelay.js'
import type { AgentTorrentConfig, AgentTorrentProvider, SendRequesterArchiveAction } from '../contracts/agentTorrent.js'
import type { AgentMagnetSearchConfig, AgentMagnetSearchProvider } from '../contracts/agentMagnetSearch.js'
import { AGENT_MAGNET_SEARCH_HELP, parseAgentMagnetSearchCommand } from '../modules/media/domain/agentMagnetSearchCommand.js'
import { validateAgentTorrentArchive, validateAgentTorrentConfig } from '../modules/media/domain/agentTorrent.js'
import { createAgentTorrentWorkflow, type AgentTorrentWorkflowContext, type AgentTorrentSource } from '../modules/media/infrastructure/agentTorrentWorkflow.js'
import { validateAgentMediaRelayPlan } from '../modules/media/domain/agentMediaRelayPlan.js'
import { validateAgentMediaRelayConfig } from '../modules/media/domain/agentMediaRelayConfig.js'
import { validateAgentMediaShare } from '../modules/media/infrastructure/agentMediaRelayReference.js'
import { sanitizeAgentXiaohongshuShareText } from '../modules/media/infrastructure/agentXiaohongshuRelayReference.js'
import { createAgentMediaOutbox, type AgentMediaOutboxContext } from '../modules/media/infrastructure/agentMediaOutbox.js'
import type { AgentMediaOutboxRecord } from '../modules/media/infrastructure/agentMediaOutboxLedger.js'
import { validateAgentAudioAttachment } from '../modules/media/infrastructure/agentAudioAttachment.js'
import { createAgentMusicExtraction, type MusicExtractionProvider } from '../modules/media/infrastructure/agentMusicExtraction.js'
import { isPersonMemoryRedacted } from '../modules/memory/domain/personMemory.js'
import { validateAgentMusicCard } from '../modules/media/infrastructure/agentMusicCard.js'
import type { AgentTool, AgentToolContext } from '../contracts/agentTool.js'
import type { AgentQqActionRunner, AgentQqActionGuard } from '../contracts/agentTool.js'
import { createAgentQqActions, type AgentQqActionsConfig } from '../modules/runtime/infrastructure/agentQqActions.js'
import { validateAgentRedPacketSnapshot } from '../modules/runtime/infrastructure/agentRedPacketValidation.js'
import { defaultSimRuntimeConfig } from '../modules/simulation/domain/simConfig.js'
import { normalizeSimToolPolicy, resolveSimToolSurface } from '../modules/simulation/domain/toolPolicy.js'
import { isAutonomousExtraToolAllowed } from '../modules/simulation/domain/executionActor.js'
import { validateAgentMedia } from '../modules/media/infrastructure/agentMediaBytes.js'
import { validateAgentFileUpload, normalizeFileDeliveryReceipt, agentFileUploadText } from '../modules/messaging/infrastructure/agentFileDelivery.js'
import { readAgentPublicFile } from '../modules/tools/infrastructure/agentPublicWeb.js'
import { abortableAgentWeb } from '../modules/tools/infrastructure/agentPublicWeb.js'
import { validateAgentFileBytes } from '../modules/content/infrastructure/agentFileBytes.js'
import type { AgentBindingSnapshot, ConversationAddress, PlatformAccountRef, PlatformUserRef } from '../contracts/agentBinding.js'
import type { ConversationMember, ConversationMemberSnapshot, ConversationMembersSnapshot, MessageImage, PlatformConnectionAdapter, PlatformConversationEvent } from '../contracts/platformConnection.js'
import type { IncomingMessage, MessageActionPort, MessageBundleItem } from '../contracts/platformMessage.js'
import type { AgentToolRegistry, AgentToolMessage, AgentToolRequest } from '../contracts/agentTool.js'
import type { DeliveryReceipt } from '../contracts/delivery.js'
import { normalizeDeliveryReceipt } from '../modules/messaging/domain/deliveryReceipt.js'
import type { TextPersonMemoryConfig } from '../contracts/textPersonMemory.js'
import type { ConversationSummaryModel, MidtermMemoryConfig, EpisodicMemoryConfig, AgentConversationMemoryCleanup,
  AgentConversationMemoryCleanupGuard, AgentConversationMemoryCleanupReceipt, AgentConversationMemoryPurgeSubject } from '../contracts/conversationMemory.js'
import type { GroupMemoryConfig, GroupMemoryModel, AgentGroupMemoryCleanup } from '../contracts/groupMemory.js'
import type { AgentSourceMemoryCleanup, AgentSourceMemoryCleanupGuard, AgentSourceMemoryPurgeSubject } from '../contracts/sourceMemoryCleanup.js'
import type { AgentSemanticMemoryConfig, AgentSemanticMemoryBackend, AgentSemanticMemoryCleanup, AgentSemanticMemoryCleanupGuard,
  AgentSemanticMemoryCleanupReceipt, AgentSemanticMemoryPurgeSubject } from '../contracts/semanticMemory.js'
import type { AgentHistoryConfig, AgentHistoryRequestSource } from '../contracts/agentHistory.js'
import { createAgentHistory } from '../modules/memory/infrastructure/agentHistory.js'
import { createAgentHistoryTool } from '../modules/tools/infrastructure/agentHistoryTool.js'
import type { AgentBindingTurn } from '../contracts/agentBinding.js'
import { createAgentTools } from '../modules/tools/infrastructure/agentTools.js'
import { createAgentMemberTools } from '../modules/tools/infrastructure/agentMemberTools.js'
import { validateMessageBundle } from '../modules/messaging/infrastructure/messageBundle.js'
import { createCommitmentRuntime } from '../modules/commitments/infrastructure/commitmentTool.js'
import type { AgentDeferredActionAuthorizationRequest, AgentDeferredActionDefinition, AgentDeferredAuthorizationCheck, AgentDeferredAuthorizationGuard } from '../contracts/agentDeferredAction.js'
import { createAgentDeferredActionPolicy, type AgentDeferredActionPolicyConfig } from '../modules/tools/infrastructure/agentDeferredActionPolicy.js'
import { createAgentDeferredActionExecutor } from '../modules/tools/infrastructure/agentDeferredActionExecutor.js'
import { createAgentDeferredActionTool } from '../modules/tools/infrastructure/agentDeferredActionTool.js'
import { createAgentDeferredPokeDefinition } from '../modules/tools/infrastructure/agentDeferredActionPoke.js'
import { createAgentDeferredActionRuntime, createAgentDeferredReminderSender } from '../modules/runtime/infrastructure/agentDeferredActionRuntime.js'
import { createTextConversation } from '../modules/conversation/infrastructure/textConversation.js'
import { createAgentTextTrigger } from '../modules/conversation/infrastructure/agentTextTrigger.js'
import { createAgentTextTriggerModels } from '../modules/conversation/infrastructure/agentTextTriggerModels.js'
import type { AgentTextTriggerConfig } from '../contracts/agentTextTrigger.js'
import { resolveAgentTextTriggerConfig } from '../modules/conversation/infrastructure/agentTextTriggerConfig.js'
import { createGroupTextTools, groupTextVideoToolNames, isTextRegistryToolName, type GroupTextToolName } from '../modules/conversation/infrastructure/groupTextTools.js'
import { createAgentTextRegistryTools, agentTextToolPorts, type AgentTextToolPorts } from '../modules/conversation/infrastructure/agentTextRegistryTools.js'
import { createAgentTextToolSources } from '../modules/conversation/infrastructure/agentTextToolSources.js'
import { createDelegateMemoryRuntime } from '../modules/memory/infrastructure/delegateMemoryTool.js'
import { matchPersonMemoryCommand, personMemoryCommand, personMemoryCommandText, type PersonMemoryCommand } from '../modules/memory/domain/personMemoryCommands.js'
import { personMemoryAddress, revokePersonMemorySourceForAccount } from '../modules/memory/infrastructure/personMemoryContext.js'
import { createPersonMemoryStore } from '../modules/memory/infrastructure/personMemoryStore.js'
import { createTextPersonMemory } from '../modules/memory/infrastructure/textPersonMemory.js'
import { createConversationMemory } from '../modules/memory/infrastructure/conversationMemory.js'
import { conversationCleanupSelector } from '../modules/memory/infrastructure/conversationMemoryCleanup.js'
import { createAgentSemanticMemory } from '../modules/memory/infrastructure/agentSemanticMemory.js'
import { createAgentCognition, cognitionCharacterReference } from '../modules/memory/infrastructure/agentCognition.js'
import { createCharacterStore } from '../modules/simulation/infrastructure/characterStore.js'
import { activeCharacterMemories } from '../modules/simulation/domain/characterState.js'
import { cognitionSourceId } from '../modules/memory/domain/cognitionState.js'
import { createCognitionStore } from '../modules/memory/infrastructure/cognitionStore.js'
import type { AgentCognitionConfig, CognitionGuard, CognitionSource } from '../contracts/agentCognition.js'
import { createGroupMemory } from '../modules/memory/infrastructure/groupMemory.js'
import { createGroupMemoryManagement } from '../modules/memory/infrastructure/groupMemoryManagement.js'
import { createGroupKnowledgeTool } from '../modules/memory/infrastructure/groupKnowledgeTool.js'
import { createPersonaSnapshot } from '../modules/conversation/infrastructure/personaSnapshot.js'
import { sanitizeFinalReplyText } from '../modules/conversation/domain/replySanitizer.js'
import { createSimulationRuntime, type SimulationRuntimePorts } from '../modules/simulation/infrastructure/simulationRuntime.js'
import { dayKey } from '../modules/simulation/domain/simConfig.js'
import { simulationAddressKey } from '../modules/simulation/infrastructure/simulationAddress.js'
import {
  agentBindingToken, agentPersonaScopeId, conversationAddressKey, isConversationAddress, isPlatformAccount,
  isPlatformIdentifier, platformAccountKey, samePlatformNamespace, agentConversationKey,
} from '../modules/runtime/domain/agentBindings.js'
import { createAgentInbox, inboxEventTarget, textConversationSeconds, type AgentInboxQueue, type AgentInboxRedis, type TextInbox } from '../modules/runtime/infrastructure/agentInbox.js'
import { createAgentDiagnostics, type AgentDiagnostics } from '../modules/runtime/infrastructure/agentDiagnostics.js'
import { generateAgentFailureNotice } from '../modules/conversation/infrastructure/agentFailureNotice.js'
import type { AgentGroupLogConfig } from '../contracts/agentGroupLog.js'
import type { AgentDiceConfig } from '../contracts/agentDice.js'
import { resolveAgentDiceConfig } from '../modules/dice/domain/agentDiceCommand.js'
import { createAgentDiceLedger } from '../modules/dice/infrastructure/agentDiceLedger.js'
import { createAgentDiceWorkflow } from '../modules/dice/infrastructure/agentDiceWorkflow.js'
import { createAgentDiceState } from '../modules/dice/infrastructure/agentDiceState.js'
import { createAgentDiceBuiltin } from '../modules/dice/infrastructure/agentDiceBuiltin.js'
import { createAgentDiceRules } from '../modules/dice/infrastructure/agentDiceRules.js'
import type { AgentDiceEngineConfig, AgentDiceEngineContext } from '../modules/dice/infrastructure/agentDiceEngine.js'
import type { AgentDiceAuthorizationGrant } from '../modules/dice/infrastructure/agentDiceAuthorization.js'
import { createAgentDiceHostBridge } from '../modules/dice/infrastructure/agentDiceHostBridge.js'
import { agentDiceSourceFingerprint } from '../modules/dice/infrastructure/agentDiceSource.js'
import { createAgentGroupLogRenderer, validateAgentGroupLogArtifact } from '../modules/dice/infrastructure/agentGroupLog.js'
import { createAgentGroupLogStore } from '../modules/dice/infrastructure/agentGroupLogStore.js'
import { createAgentGroupLogWorkflow } from '../modules/dice/infrastructure/agentGroupLogWorkflow.js'
import { parseAgentGroupLogCommand } from '../modules/dice/domain/agentGroupLogCommand.js'
import { createAgentConversationActivity } from '../modules/runtime/infrastructure/agentConversationActivity.js'
import { createAgentLocalEmojiIngress } from '../modules/emoji/infrastructure/agentLocalEmojiIngress.js'
import type { AgentLocalEmojiCleanupGuard, AgentLocalEmojiCleanupReceipt, AgentLocalEmojiRuntime } from '../contracts/agentLocalEmoji.js'
import type { AgentVideoCard, AgentVideoSearchProvider } from '../contracts/agentVideoCard.js'
import { validateAgentVideoCard } from '../modules/media/infrastructure/agentVideoCard.js'
import { createAgentVideoSearchStore } from '../modules/media/infrastructure/agentVideoSearchStore.js'
import type { AgentGroupGameContext, AgentGroupGameHandler, AgentGroupGameSendGuard } from '../contracts/agentGames.js'
import { validateAgentToolImage } from '../modules/image/infrastructure/agentToolImage.js'

type ResolvePersona = NonNullable<ReturnType<SimulationRuntimePorts['getPersona']>> & { binding: AgentBindingSnapshot }
type RuntimePorts = Pick<SimulationRuntimePorts, 'logger' | 'getSection' | 'getExecutionConfig' | 'YTapi' | 'recordTokens' | 'getTodaySpendCny' | 'reflectCharacter' | 'reviewCharacter' | 'judgeSocialPermission' | 'describeImages' | 'personProfileExtract' | 'wakeGateJudge' | 'memeExtract' | 'lifeThreadProvider' | 'isLifeThreadsCurrent' | 'collectMessageSticker' | 'isLocalEmojiCurrent' | 'now'>

export const AGENT_DEFERRED_POKE_DEFINITION_ID = 'core:deferred-poke:v1'

export interface AgentRuntimeOptions extends RuntimePorts {
  diagnostics?: AgentDiagnostics
  failureNoticeFallback?: string
  storage: SimulationRuntimePorts['redis'] & AgentInboxRedis
  adapters: readonly PlatformConnectionAdapter[]
  resolvePersona(target: ConversationAddress): ResolvePersona | undefined
  /** Optional trusted directory for scoped management; never supplied by model or browser input. */
  managementBindings?: AgentManagementBindings
  isExecutionCurrent?(): boolean
  /** Observe one pure synchronous predicate with fresh configuration fences. */
  observeExecutionCurrent?(check: () => boolean): boolean
  /** Share the host configuration observation for one synchronous tool permission check. */
  checkToolCurrent?(check: () => boolean): boolean
  signal?: AbortSignal
  allowsText?(text: string, direction: 'incoming' | 'outgoing'): boolean
  /** Host credentials, including newly refreshed values, cannot become model-selected tool inputs. */
  allowsToolInput?(input: string): boolean
  privateChatEnabled?: boolean
  privateTextTools?: readonly string[]
  useTextGroup?(target: ConversationAddress): boolean
  textGroupRevision?: string
  textTrigger?: AgentTextTriggerConfig
  isTextTriggerCurrent?(): boolean
  textTriggerModel?: Parameters<typeof createAgentTextTriggerModels>[0]['model']
  groupTextTools?(target: ConversationAddress): readonly GroupTextToolName[]
  toolRegistry?: AgentToolRegistry
  /** Trusted group-game factories receive only Core-authorized source contexts. */
  createGroupGames?(ports: {
    authorizeBackground(input: { source: IncomingMessage; binding: AgentBindingSnapshot }): Promise<AgentGroupGameContext | undefined>
  }): readonly AgentGroupGameHandler[]
  /** Independent bounded collection of verified human ingress images. */
  autoCollectLocalEmoji?: boolean
  /** Trusted privacy cleanup remains available when collection and sending are disabled. */
  localEmojiCleanup?: Pick<AgentLocalEmojiRuntime, 'revokeSource' | 'purgeSubject'>
  memorySystem?: TextPersonMemoryConfig
  midtermMemory?: MidtermMemoryConfig
  episodicMemory?: EpisodicMemoryConfig
  summarizeConversation?: ConversationSummaryModel
  groupMemory?: GroupMemoryConfig
  groupMemoryModel?: GroupMemoryModel
  semanticMemory?: AgentSemanticMemoryConfig
  semanticMemoryBackend?: AgentSemanticMemoryBackend
  cognition?: AgentCognitionConfig
  history?: AgentHistoryConfig
  musicExtraction?: AgentMusicExtractionConfig
  groupLog?: AgentGroupLogConfig
  dice?: AgentDiceConfig
  /** Explicit independent business engine; the legacy public-expression path remains compatible. */
  diceEngine?: AgentDiceEngineConfig
  readDiceGrant?(request: { readonly binding: AgentBindingSnapshot; readonly source: IncomingMessage },
    guard: import('../modules/dice/infrastructure/agentDiceState.js').AgentDiceStateGuard): Promise<AgentDiceAuthorizationGrant | undefined>
  isDiceCurrent?(): boolean
  bilibiliQuality?: AgentBilibiliQualityConfig
  bilibiliAuthService?: AgentBilibiliAuthService
  bilibiliQualityProviderFor?(binding: AgentBindingSnapshot): AgentBilibiliQualityProvider | undefined
  isBilibiliQualityCurrent?(): boolean
  videoSearchProvider?: AgentVideoSearchProvider
  isVideoSearchCurrent?(): boolean
  interactions?: { readonly enabled: boolean }
  isInteractionsCurrent?(): boolean
  qqActions?: AgentQqActionsConfig
  isQqActionsCurrent?(): boolean
  deferredActions?: AgentDeferredActionPolicyConfig
  isDeferredActionsCurrent?(): boolean
  getDeferredActionDefinitions?(): readonly AgentDeferredActionDefinition[]
  /** Explicit trusted offline approval verification, required for migrated extra actions. */
  verifyDeferredMigration?(request: AgentDeferredActionAuthorizationRequest, guard: AgentDeferredAuthorizationGuard): Promise<AgentDeferredAuthorizationCheck>
  /** A trusted host may inject its bounded music resolver; model arguments cannot select a provider. */
  musicExtractionProvider?: MusicExtractionProvider
  /** Revokes this deterministic service when its host authorization snapshot changes. */
  isMusicExtractionCurrent?(): boolean
  mediaRelay?: AgentMediaRelayConfig
  mediaRelayProvider?: AgentMediaRelayProvider
  isMediaRelayCurrent?(): boolean
  torrentDownload?: AgentTorrentConfig
  torrentProvider?: AgentTorrentProvider
  isTorrentDownloadCurrent?(): boolean
  magnetSearch?: AgentMagnetSearchConfig
  magnetSearchProvider?: AgentMagnetSearchProvider
  isMagnetSearchCurrent?(): boolean
  /** Optional neutral card renderer. Core retains the complete text fallback. */
  renderTorrentListing?(text: string, context: import('../contracts/agentMediaRelay.js').AgentMediaResourceContext): Promise<{ readonly mime: string; readonly base64: string }>
}

function isMessageId(value: unknown): value is string {
  return isPlatformIdentifier(value) && value !== '0'
}

/** Strip ephemeral share access before persistence or model-facing source reads. */
function mediaSafeMessage(message: IncomingMessage): IncomingMessage {
  const parts = (values: IncomingMessage['parts']) => values.map(part => part.kind === 'text'
    ? { ...part, text: sanitizeAgentXiaohongshuShareText(part.text) } : part)
  return { ...message, text: sanitizeAgentXiaohongshuShareText(message.text), parts: parts(message.parts),
    ...(message.senderName === undefined ? {} : { senderName: sanitizeAgentXiaohongshuShareText(message.senderName) }),
    ...(message.quote ? { quote: { ...message.quote, parts: parts(message.quote.parts),
      ...(message.quote.authorName === undefined ? {} : { authorName: sanitizeAgentXiaohongshuShareText(message.quote.authorName) }),
      ...(message.quote.text === undefined ? {} : { text: sanitizeAgentXiaohongshuShareText(message.quote.text) }) } } : {}) }
}

function isSameBinding(candidate: AgentBindingSnapshot, expected: AgentBindingSnapshot): boolean {
  return isConversationAddress(candidate.target) && conversationAddressKey(candidate.target) === expected.id &&
    agentBindingToken(candidate) === agentBindingToken(expected)
}

function isInboundUser(value: PlatformAccountRef, adapter: PlatformConnectionAdapter): boolean {
  return isPlatformAccount(value) && samePlatformNamespace(value, adapter.account) && value.id !== adapter.botUserId
}

function quoteReference(quote: IncomingMessage['quote']): Pick<IncomingMessage, 'quote'> {
  return isMessageId(quote?.messageId) ? { quote: { messageId: quote.messageId, parts: [] } } : {}
}

function hasValidInboundEvent(event: PlatformConversationEvent, adapter: PlatformConnectionAdapter): boolean {
  if (event.kind === 'recall') return isMessageId(event.messageId)
  if (event.kind === 'nudge') return isInboundUser(event.sender, adapter) &&
    Number.isSafeInteger(event.occurredAt) && event.occurredAt > 0
  if (event.kind === 'red-packet') {
    try { const packet = validateAgentRedPacketSnapshot(event.packet, Date.now()); return event.target.kind === 'group' &&
      conversationAddressKey(packet.target) === conversationAddressKey(event.target) && isInboundUser(packet.source.author, adapter) }
    catch { return false }
  }
  const message = event.message
  return message.version === 1 && isMessageId(message.messageId) &&
    isInboundUser(message.sender, adapter) && Number.isSafeInteger(message.occurredAt) && message.occurredAt > 0 &&
    typeof message.text === 'string' && Array.isArray(message.parts) && Array.isArray(message.mentions) &&
    typeof message.directedToAccount === 'boolean'
}

const privacyConfirmations: Record<PersonMemoryCommand, { group: string; private: string }> = {
  forget: { group: '已清空你在本群的记忆，已删除的资料不会恢复。',
    private: '已清空此账号下当前角色对你的记忆，已删除的资料不会恢复。' },
  disable: { group: '已禁用你在本群的人物记忆。', private: '已禁用此账号下当前角色对你的记忆。' },
  enable: { group: '已启用你在本群的人物记忆权限。私聊中设置的全场景禁用仍然有效，旧资料不会恢复。',
    private: '已启用此账号下当前角色对你的记忆，旧资料不会恢复。' },
}
const privacyCommandMaxAgeMs = textConversationSeconds * 1000
const privacyCommandClockSkewMs = 60_000

export function createAgentRuntime(options: AgentRuntimeOptions) {
  const checkToolCurrent = (check: () => boolean): boolean => {
    const observed = () => observeCurrent(check)
    return options.checkToolCurrent ? options.checkToolCurrent(observed) : observed()
  }
  const diagnostics = options.diagnostics ?? createAgentDiagnostics({ logger: options.logger, ...(options.now ? { now: options.now } : {}) })
  // All module loggers pass this metadata-only boundary; free-form upstream
  // log strings can include credentials or temporary source content.
  options = { ...options, logger: diagnostics.logger,
    failureNoticeFallback: options.failureNoticeFallback ?? '这次服务暂时异常，暂时无法确认结果。请先核实操作状态。' }
  const torrentConfig = validateAgentTorrentConfig(options.torrentDownload)
  const qualityConfig = validateAgentBilibiliQualityConfig(options.bilibiliQuality)
  if (qualityConfig.enabled && (!options.bilibiliAuthService || typeof options.bilibiliQualityProviderFor !== 'function')) {
    throw new TypeError('启用B站高清命令必须配置 Core 授权服务与高清提供器')
  }
  options = { ...options, bilibiliQuality: qualityConfig }
  if (torrentConfig.enabled && typeof options.torrentProvider?.prepare !== 'function') throw new TypeError('启用磁链下载必须配置 Core 磁链提供器')
  if (options.magnetSearch?.enabled && typeof options.magnetSearchProvider?.search !== 'function') throw new TypeError('启用磁力搜索必须配置 Core 搜索提供器')
  const mediaRelayConfig = validateAgentMediaRelayConfig(options.mediaRelay)
  if (mediaRelayConfig.enabled && typeof options.mediaRelayProvider?.prepare !== 'function') {
    throw new TypeError('启用媒体搬运必须配置 Core 媒体提供器')
  }
  const { storage, logger, resolvePersona } = options
  if (options.groupLog !== undefined) {
    const config = options.groupLog
    if (!config || typeof config !== 'object' || Object.keys(config).some(key => !['enabled', 'maxBytes', 'masters'].includes(key)) ||
        typeof config.enabled !== 'boolean' || config.maxBytes !== undefined && (!Number.isSafeInteger(config.maxBytes) || config.maxBytes < 1024 * 1024 || config.maxBytes > 100 * 1024 * 1024) ||
        config.masters !== undefined && (!Array.isArray(config.masters) || config.masters.length > 100 || config.masters.some(user => !isPlatformAccount(user)))) {
      throw new Error('团录需要显式开关、完整文件预算和可信主人身份')
    }
  }
  if (options.history !== undefined) {
    const history = options.history
    if (!history || typeof history !== 'object' || Object.keys(history).some(key => !['enabled', 'retentionDays', 'maxMessagesPerConversation', 'timeoutMs'].includes(key)) ||
        history.enabled !== undefined && typeof history.enabled !== 'boolean' ||
        (['retentionDays', 'maxMessagesPerConversation', 'timeoutMs'] as const).some((key, i) => history[key] !== undefined &&
          (!Number.isSafeInteger(history[key]) || history[key]! < [1, 50, 100][i]! || history[key]! > [90, 2000, 30000][i]!))) {
      throw new Error('history 需要显式开关及有界的保留期、数量和读取时限')
    }
  }
  if (options.semanticMemory?.enabled === true && (!options.semanticMemoryBackend || !/^[a-f0-9]{64}$/u.test(options.semanticMemoryBackend.id))) {
    throw new Error('启用独立语义记忆需要显式后端和有效的向量空间标识')
  }
  if (options.cognition !== undefined && (!options.cognition || typeof options.cognition !== 'object' ||
      Object.keys(options.cognition).some(key => key !== 'enabled') || typeof options.cognition.enabled !== 'boolean')) {
    throw new Error('统一认知需要显式布尔开关 cognition.enabled')
  }
  const connectionIds = new Set(options.adapters.map(adapter => adapter.id))
  if (connectionIds.size !== options.adapters.length ||
      options.adapters.some(adapter => !isPlatformIdentifier(adapter.id) || !isPlatformAccount(adapter.account) ||
        !isPlatformIdentifier(adapter.botUserId))) {
    throw new Error('独立宿主连接需要有效账号和唯一连接 ID')
  }
  const adapters = new Map(options.adapters.map(adapter => [platformAccountKey(adapter.account), adapter]))
  if (adapters.size === 0 || adapters.size !== options.adapters.length) throw new Error('独立宿主需要至少一个不重复的平台账号')
  const diceConfig = resolveAgentDiceConfig(options.dice)
  const triggerConfigKey = JSON.stringify(resolveAgentTextTriggerConfig(options.textTrigger))
  const diceConfigKey = JSON.stringify(diceConfig)
  const diceEngineConfigKey = JSON.stringify(options.diceEngine ?? null)
  const diceLedger = createAgentDiceLedger(storage)
  const diceState = createAgentDiceState(storage)
  const diceRevocationBuiltin = createAgentDiceBuiltin({ ...options.diceEngine?.builtin, enabled: true })
  const diceRevocationRules = createAgentDiceRules({ packages: options.diceEngine?.rulePackages ?? [] })
  const diceRevocationCandidate = (message: IncomingMessage) => message.text.trim().split(/(?=[.。])/u)
    .some(command => diceRevocationBuiltin.isCandidate(command) || diceRevocationRules.isCandidate(command))
  async function revokeDiceSource(target: ConversationAddress, messageId: string): Promise<void> {
    const results = await Promise.allSettled([
      diceState.revokeSourceByTarget(target, messageId), diceLedger.revokeSource(target, messageId),
    ])
    const rejected = results.find(result => result.status === 'rejected')
    if (rejected?.status === 'rejected') throw rejected.reason
  }
  const inbox = createAgentInbox(storage)
  const toolLogger = logger
  const memories = createDelegateMemoryRuntime({ redis: storage, logger: toolLogger, loadConfig: () => ({}), ...(options.now ? { now: options.now } : {}) })
  const personMemory = createPersonMemoryStore({ redis: storage, ...(options.now ? { now: options.now } : {}) })
  const pendingSends = new Map<string, Set<() => void>>()
  const controlPendingSends = new WeakSet<() => void>()
  const controlDelivery = new AsyncLocalStorage<boolean>()
  const pendingTools = new Map<string, Set<() => void>>()
  const memoryTurns = new Map<string, Map<() => void, { agentId: string; targetKey: string; requiresAI: boolean }>>()
  const activity = createAgentConversationActivity()
  const groupLogs = createAgentGroupLogStore(storage)
  const groupLogEnabled = options.groupLog?.enabled === true
  let activityHydrated = !groupLogEnabled
  const activityStates = new Map<string, { target: ConversationAddress; allowed: boolean }>()
  const silenceReservations = new Map<string, { target: ConversationAddress; messages: Set<string>; admitting: Set<string> }>()
  const admissions = new Map<string, Promise<void>>()
  const pendingAdmissions = new Set<Promise<void>>()
  const automaticQqWork = new Map<string, Promise<void>>()
  const controlActions = new WeakSet<object>()
  const privacyAdmissions = new Map<string, number>()
  const privacyBacklog = new Set<string>()
  const privacyWaiters = new Map<string, { promise: Promise<void>; resolve: () => void }>()
  let stopping = false
  const toolCancellation = new AbortController()

  function adapterFor(target: ConversationAddress) { return adapters.get(platformAccountKey(target.account)) }
  function privatePeerFor(target: ConversationAddress, adapter = adapterFor(target)): string | undefined {
    if (target.kind !== 'private' || !adapter?.isReady()) return undefined
    try {
      const peer = adapter.resolvePrivatePeer ? adapter.resolvePrivatePeer(target) : { ...target.account, id: target.id }
      if (!peer || !samePlatformNamespace(target.account, peer) || peer.id === adapter.botUserId || !isPlatformIdentifier(peer.id)) return undefined
      return peer.id
    } catch { return undefined }
  }
  function isRunning(): boolean {
    return !stopping && !options.signal?.aborted && options.isExecutionCurrent?.() !== false
  }
  function observeCurrent(check: () => boolean): boolean {
    return options.observeExecutionCurrent ? options.observeExecutionCurrent(check) === true : check()
  }
  function sourceCleanupGuard(isAuthorized: () => boolean = () => true,
    ensureAuthorized?: () => void | Promise<void>, parentSignal?: AbortSignal): AgentSemanticMemoryCleanupGuard {
    const signal = AbortSignal.any([toolCancellation.signal, ...(options.signal ? [options.signal] : []), ...(parentSignal ? [parentSignal] : [])])
    const guard: AgentSemanticMemoryCleanupGuard = {
      signal,
      isCurrent() { try { return observeCurrent(() => !signal.aborted && isRunning() && isAuthorized()) } catch { return false } },
      async ensureCurrent() {
        if (!guard.isCurrent()) throw new Error('来源清理权限已失效')
        await ensureAuthorized?.()
        if (!guard.isCurrent()) throw new Error('来源清理权限已失效')
      },
    }
    return guard
  }
  async function completeLocalEmojiCleanup(operation: (guard: AgentLocalEmojiCleanupGuard) => Promise<AgentLocalEmojiCleanupReceipt>,
    guard = sourceCleanupGuard()): Promise<AgentLocalEmojiCleanupReceipt> {
    await guard.ensureCurrent()
    const receipt = await operation(guard)
    await guard.ensureCurrent()
    if (receipt.usage !== 'blocked' || receipt.cleanup !== 'completed' && receipt.cleanup !== 'unsupported') throw new Error('本地表情清理尚未完成')
    return receipt
  }
  async function completeSemanticMemoryCleanup(input: AgentSemanticMemoryPurgeSubject,
    guard = sourceCleanupGuard()): Promise<AgentSemanticMemoryCleanupReceipt> {
    const receipt = await semanticMemoryCleanup.purgeSubject(input, guard)
    if (receipt.usage !== 'blocked' || receipt.cleanup !== 'completed') throw new Error('语义记忆清理尚未完成')
    return receipt
  }
  async function completeConversationMemoryCleanup(input: AgentConversationMemoryPurgeSubject,
    guard = sourceCleanupGuard()): Promise<AgentConversationMemoryCleanupReceipt> {
    const receipt = await conversationMemoryCleanup.purgeSubject(input, guard)
    if (receipt.usage !== 'blocked' || receipt.cleanup !== 'completed') throw new Error('会话记忆清理尚未完成')
    return receipt
  }
  async function completeSourceMemoryCleanup(input: AgentSourceMemoryPurgeSubject, guard = sourceCleanupGuard()) {
    const receipt = await sourceMemoryCleanup.purgeSubject(input, guard)
    if (receipt.usage !== 'blocked' || receipt.partitions.some(partition => partition.cleanup !== 'completed')) throw new Error('来源记忆清理尚未完成')
    return receipt
  }
  async function completeGroupMemoryCleanup(input: AgentSourceMemoryPurgeSubject, guard = sourceCleanupGuard()) {
    const receipt = await groupMemoryCleanup.purgeSubject(input, guard)
    if (receipt.usage !== 'blocked' || receipt.cleanup !== 'completed') throw new Error('群记忆清理尚未完成')
    return receipt
  }
  function conversationEnabled(target: ConversationAddress): boolean {
    return options.getSection().enabled !== false && (target.kind !== 'private' || options.privateChatEnabled === true)
  }
  function diceCurrent(): boolean {
    try { return isRunning() && (diceConfig.enabled || options.diceEngine?.enabled === true) && options.isDiceCurrent?.() !== false &&
      JSON.stringify(resolveAgentDiceConfig(options.dice)) === diceConfigKey && JSON.stringify(options.diceEngine ?? null) === diceEngineConfigKey }
    catch { return false }
  }
  function allowsConversationAI(target: ConversationAddress): boolean {
    const binding = bindingFor(target)?.binding
    return activityHydrated && activity.allows(target) && (!binding || !gameHandlers.some(handler => handler.isActive?.(binding)))
  }
  function setConversationAI(target: ConversationAddress, allowed: boolean): void {
    const key = conversationAddressKey(target)
    activityStates.set(key, { target, allowed })
    const actual = allowed && !silenceReservations.get(key)?.messages.size
    if (!actual) {
      activity.set(target, false)
      textConversation.invalidate(target)
      textTrigger.invalidate(target)
      runtime.invalidateConversation(target)
      for (const invalidate of pendingSends.get(key) ?? []) if (!controlPendingSends.has(invalidate)) invalidate()
      for (const invalidate of pendingTools.get(key) ?? []) invalidate()
      for (const [invalidate, turn] of memoryTurns.get(platformAccountKey(target.account)) ?? []) if (turn.targetKey === key && turn.requiresAI) invalidate()
    } else activity.set(target, true)
  }
  function textInboxFor(target: ConversationAddress): TextInbox | undefined {
    if (target.kind === 'private' || (target.kind === 'group' && options.useTextGroup?.(target))) {
      return { account: target.account, kind: target.kind }
    }
  }
  function bindingFor(target: ConversationAddress): ResolvePersona | undefined {
    if (!isConversationAddress(target)) return undefined
    const connection = adapterFor(target)
    if (!connection) return undefined
    const persona = resolvePersona(target)
    const binding = persona?.binding
    if (binding?.source !== 'configured' || binding.connectionId !== connection.id ||
        !isConversationAddress(binding.target) || binding.id !== conversationAddressKey(target) ||
        binding.id !== conversationAddressKey(binding.target) || typeof binding.revision !== 'string' || !binding.revision.trim()) return undefined
    return persona
  }
  function bindingIsCurrent(target: ConversationAddress, expected: string): boolean {
    try {
      const current = bindingFor(target)
      return !!current && agentBindingToken(current.binding) === expected
    } catch { return false }
  }
  function textBindingToken(binding: AgentBindingSnapshot): string {
    const token = agentBindingToken(binding)
    if (binding.target.kind === 'private' && options.privateTextTools?.length) return JSON.stringify([token, 'private-tools', [...options.privateTextTools].sort()])
    if (binding.target.kind === 'group' && options.textTrigger !== undefined) return JSON.stringify([token, options.textGroupRevision ?? '', 'text-trigger-v1', triggerConfigKey])
    return binding.target.kind === 'group' && options.textGroupRevision ? JSON.stringify([token, options.textGroupRevision]) : token
  }
  function freshMemberObservation(at: number, startedAt: number): boolean {
    return Number.isSafeInteger(at) && at >= startedAt - 5_000 && at <= Date.now() + 5_000
  }
  function projectMember(member: ConversationMember, target: ConversationAddress): ConversationMember | undefined {
    if (!member || !isPlatformAccount(member.user) || !samePlatformNamespace(target.account, member.user) ||
        typeof member.displayName !== 'string' || member.displayName.length > 240 || !['member', 'admin', 'owner', 'unknown'].includes(member.role)) return undefined
    const profile = member.profile
    if (profile !== undefined) {
      if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return undefined
      for (const [name, value] of Object.entries(profile)) {
        if (['nickname', 'conversationName', 'title', 'level', 'region'].includes(name)) {
          if (typeof value !== 'string' || value.length > 240 || /[\u0000-\u001f\u007f]/u.test(value)) return undefined
        } else if (['joinedAt', 'lastSpokeAt', 'mutedUntil'].includes(name)) {
          if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || !Number.isFinite(new Date(value).getTime())) return undefined
        } else if (name === 'age') {
          if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 150) return undefined
        } else if (name !== 'gender' || typeof value !== 'string' || !['male', 'female', 'unknown'].includes(value)) return undefined
      }
    }
    return { user: { platform: member.user.platform, namespace: member.user.namespace, id: member.user.id },
      displayName: member.displayName, role: member.role, ...(profile ? { profile: structuredClone(profile) } : {}) }
  }
  async function readGroupMembers(target: ConversationAddress, signal: AbortSignal, guard: () => boolean): Promise<ConversationMembersSnapshot | undefined> {
    const adapter = adapterFor(target), startedAt = Date.now()
    const isCurrent = () => isRunning() && !signal.aborted && guard() && adapterFor(target) === adapter && adapter?.isReady() === true
    if (target.kind !== 'group' || !isCurrent() || !adapter?.listConversationMembers) return undefined
    const result = await adapter.listConversationMembers(target, { signal, isCurrent })
    if (!result || !isCurrent() || result.complete !== true || !isConversationAddress(result.target) ||
        conversationAddressKey(result.target) !== conversationAddressKey(target) || !freshMemberObservation(result.observedAt, startedAt) ||
        !Array.isArray(result.members) || result.members.length > 5000 ||
        result.members.some(member => !projectMember(member, target)) ||
        new Set(result.members.map(member => member.user.id)).size !== result.members.length) return undefined
    return { target: structuredClone(target), observedAt: result.observedAt, complete: true, members: result.members.map(member => {
      const projected = projectMember(member, target)!
      return { user: projected.user, displayName: projected.displayName, role: projected.role,
        ...(projected.profile ? { profile: { ...(projected.profile.nickname ? { nickname: projected.profile.nickname } : {}),
          ...(projected.profile.conversationName ? { conversationName: projected.profile.conversationName } : {}) } } : {}) }
    }) }
  }
  async function readGroupMember(target: ConversationAddress, userId: string, signal: AbortSignal, guard: () => boolean): Promise<ConversationMemberSnapshot | undefined> {
    const adapter = adapterFor(target), startedAt = Date.now()
    const isCurrent = () => isRunning() && !signal.aborted && guard() && adapterFor(target) === adapter && adapter?.isReady() === true
    if (target.kind !== 'group' || !isCurrent() || !adapter?.readConversationMember) return undefined
    const result = await adapter.readConversationMember(target, { ...target.account, id: userId }, { signal, isCurrent })
    if (!result || !isCurrent() || !isConversationAddress(result.target) || conversationAddressKey(result.target) !== conversationAddressKey(target) ||
        !projectMember(result.member, target) || result.member.user.id !== userId || !freshMemberObservation(result.observedAt, startedAt)) return undefined
    return { target: structuredClone(target), observedAt: result.observedAt, member: projectMember(result.member, target)! }
  }
  function privacyBlocked(key: string): boolean { return privacyBacklog.has(key) || privacyAdmissions.has(key) }
  function wakeMemoryTurns(key: string) {
    if (privacyBlocked(key)) return
    privacyWaiters.get(key)?.resolve()
    privacyWaiters.delete(key)
  }
  function setPrivacyBacklog(key: string, pending: boolean) {
    if (pending) privacyBacklog.add(key)
    else privacyBacklog.delete(key)
    wakeMemoryTurns(key)
  }
  function beginPrivacyAdmission(binding: AgentBindingSnapshot) {
    const key = platformAccountKey(binding.target.account)
    privacyAdmissions.set(key, (privacyAdmissions.get(key) ?? 0) + 1)
    // Shared teaching can originate from another Agent in this account.
    for (const invalidate of memoryTurns.get(key)?.keys() ?? []) invalidate()
    adapterFor(binding.target)?.invalidateRedPacketSources?.()
    groupLogWorkflow.invalidateAccount(binding.target.account)
    bilibiliQuality?.invalidateAccount(binding.target.account)
    return () => {
      const remaining = (privacyAdmissions.get(key) ?? 1) - 1
      if (remaining > 0) privacyAdmissions.set(key, remaining)
      else privacyAdmissions.delete(key)
      wakeMemoryTurns(key)
    }
  }
  async function beginMemoryTurn(binding: AgentBindingSnapshot, requiresAI = true) {
    const key = platformAccountKey(binding.target.account)
    while (isRunning() && privacyBlocked(key)) {
      let waiter = privacyWaiters.get(key)
      if (!waiter) {
        let resolve!: () => void
        const promise = new Promise<void>(done => { resolve = done })
        waiter = { promise, resolve }
        privacyWaiters.set(key, waiter)
      }
      await waiter.promise
    }
    return captureMemoryTurn(binding, requiresAI)
  }
  function captureMemoryTurn(binding: AgentBindingSnapshot, requiresAI = true) {
    const key = platformAccountKey(binding.target.account)
    const controller = new AbortController()
    const aiTurn = requiresAI ? activity.capture(binding.target) : undefined
    const invalidate = () => controller.abort(new Error('人物记忆权限已改变'))
    const active = memoryTurns.get(key) ?? new Map<() => void, { agentId: string; targetKey: string; requiresAI: boolean }>()
    active.set(invalidate, { agentId: binding.agentId, targetKey: conversationAddressKey(binding.target), requiresAI })
    memoryTurns.set(key, active)
    return {
      isCurrent: () => observeCurrent(() => isRunning() && !privacyBlocked(key) &&
        (!requiresAI || allowsConversationAI(binding.target) && aiTurn?.isCurrent() === true) && !controller.signal.aborted),
      signal: AbortSignal.any([controller.signal, ...(aiTurn ? [aiTurn.signal] : [])]),
      release() {
        aiTurn?.release()
        active.delete(invalidate)
        if (!active.size && memoryTurns.get(key) === active) memoryTurns.delete(key)
      },
    }
  }
  function guardPendingSend(targetKey: string, check: () => boolean, requiresAI = controlDelivery.getStore() !== true) {
    let current = true
    const invalidate = () => { current = false }
    if (!requiresAI) controlPendingSends.add(invalidate)
    const waiting = pendingSends.get(targetKey) ?? new Set<() => void>()
    waiting.add(invalidate)
    pendingSends.set(targetKey, waiting)
    return {
      isCurrent() {
        if (current) {
          current = false
          try { current = check() } catch { /* The pending send has lost its authorization. */ }
        }
        return current
      },
      release() {
        waiting.delete(invalidate)
        if (!waiting.size && pendingSends.get(targetKey) === waiting) pendingSends.delete(targetKey)
      },
    }
  }

  const outboundMessages = createAgentOutboundMessages(storage)
  const rawMessageActions: MessageActionPort = {
    async interact(action, guard) {
      const target = action.target, live = isConversationAddress(target) && bindingFor(target), adapter = isConversationAddress(target) && adapterFor(target)
      if (!interactionsCurrent() || !live || !adapter || !adapter.actions.interact || !isSameBinding(action.binding, live.binding) ||
          target.kind === 'private' && (!privatePeerFor(target, adapter) ||
            action.interaction.kind !== 'profile-like' && action.interaction.kind !== 'message-recall' ||
            action.interaction.kind === 'profile-like' && action.interaction.user.id !== privatePeerFor(target, adapter))) {
        return { state: 'failed', code: 'interaction_unavailable' }
      }
      const expected = agentBindingToken(live.binding)
      const pending = guardPendingSend(conversationAddressKey(target), () => isRunning() && interactionsCurrent() && adapter.isReady() &&
        adapterFor(target) === adapter && !guard?.signal?.aborted && guard?.isCurrent?.() !== false && conversationEnabled(target) && bindingIsCurrent(target, expected))
      try {
        if (!pending.isCurrent()) return { state: 'failed', code: 'binding_changed' }
        return normalizeInteractionReceipt(await adapter.actions.interact(action, { isCurrent: pending.isCurrent,
          ...(guard?.signal ? { signal: guard.signal } : {}), ...(guard?.ensureCurrent ? { ensureCurrent: guard.ensureCurrent } : {}) }))
      } catch { return { state: 'unknown' } }
      finally { pending.release() }
    },
    async sendRequesterBilibiliAuth(action, guard) {
      const target = action.source?.target
      if (!bilibiliQualityCurrent() || action.version !== 1 || action.kind !== 'bilibili-auth.notify' || !isConversationAddress(target) ||
          !['private', 'group'].includes(target.kind)) return { state: 'failed', code: 'invalid_bilibili_auth_notice' }
      const live = bindingFor(target), adapter = adapterFor(target)
      if (!live || !adapter?.actions.sendRequesterBilibiliAuth || !isSameBinding(action.binding, live.binding)) return { state: 'failed', code: 'bilibili_auth_unavailable' }
      if (action.content.kind === 'text' && options.allowsText?.(action.content.text, 'outgoing') === false) return { state: 'failed', code: 'forbidden_text' }
      const token = agentBindingToken(live.binding)
      const pending = guardPendingSend(conversationAddressKey(target), () => bilibiliQualityCurrent() && adapter.isReady() && adapterFor(target) === adapter &&
        !guard?.signal?.aborted && guard?.isCurrent?.() === true && conversationEnabled(target) && bindingIsCurrent(target, token))
      try {
        if (!pending.isCurrent()) return { state: 'failed', code: 'binding_changed' }
        return normalizeDeliveryReceipt(await adapter.actions.sendRequesterBilibiliAuth(action, { isCurrent: pending.isCurrent, ...(guard?.signal ? { signal: guard.signal } : {}) }))
      } catch { return { state: 'unknown' } }
      finally { pending.release() }
    },
    async sendDicePrivate(request, guard) {
      const target = request.binding?.target, adapter = isConversationAddress(target) ? adapterFor(target) : undefined
      const live = isConversationAddress(target) ? bindingFor(target)?.binding : undefined
      if (!controlActions.has(request) || !diceCurrent() || !live || target.kind !== 'group' || !adapter?.actions.sendDicePrivate ||
          !isSameBinding(live, request.binding) || !isSameBinding(live, request.origin.binding) ||
          options.allowsText?.(request.text, 'outgoing') === false || options.allowsToolInput?.(request.text) === false) {
        return { state: 'failed', code: 'dice_private_unavailable' }
      }
      const token = agentBindingToken(live)
      const pending = guardPendingSend(conversationAddressKey(target), () => diceCurrent() && adapterFor(target) === adapter && adapter.isReady() &&
        !guard.signal.aborted && guard.isCurrent() && conversationEnabled(target) && bindingIsCurrent(target, token))
      const ensureCurrent = async () => {
        if (!pending.isCurrent()) throw new Error('骰子私聊来源已失效')
        await guard.ensureCurrent()
        if (!pending.isCurrent()) throw new Error('骰子私聊来源已失效')
      }
      try {
        await ensureCurrent()
        return normalizeDeliveryReceipt(await adapter.actions.sendDicePrivate(request, {
          signal: guard.signal, isCurrent: pending.isCurrent, ensureCurrent,
        }))
      } catch { return { state: 'unknown' } }
      finally { pending.release() }
    },
    async sendGamePrivate(request, guard) {
      const target = request.binding?.target, adapter = isConversationAddress(target) ? adapterFor(target) : undefined
      const live = isConversationAddress(target) ? bindingFor(target)?.binding : undefined
      if (!controlActions.has(request) || !live || target.kind !== 'group' || !adapter?.actions.sendGamePrivate ||
          !isSameBinding(live, request.binding) || !isSameBinding(live, request.origin.binding) ||
          options.allowsText?.(request.text, 'outgoing') === false || options.allowsToolInput?.(request.text) === false) return { state: 'failed', code: 'game_private_unavailable' }
      const pending = guardPendingSend(conversationAddressKey(target), () => isRunning() && adapterFor(target) === adapter && adapter.isReady() &&
        !guard.signal.aborted && guard.isCurrent() && bindingIsCurrent(target, agentBindingToken(live)))
      const ensureCurrent = async () => {
        if (!pending.isCurrent()) throw new Error('游戏私发来源已失效')
        await guard.ensureCurrent()
        if (!pending.isCurrent()) throw new Error('游戏私发来源已失效')
      }
      try {
        await ensureCurrent()
        return normalizeDeliveryReceipt(await adapter.actions.sendGamePrivate(request, { signal: guard.signal, isCurrent: pending.isCurrent, ensureCurrent }))
      } catch { return { state: 'unknown' } }
      finally { pending.release() }
    },
    async sendVideoCard(action, guard) {
      const target = action.target
      if (action.version !== 1 || action.kind !== 'video-card.send' || !isConversationAddress(target) || target.kind !== 'group') return { state: 'failed', code: 'invalid_video_card' }
      let card: Readonly<AgentVideoCard>
      try { card = validateAgentVideoCard(action.card, text => options.allowsText?.(text, 'outgoing') !== false) }
      catch { return { state: 'failed', code: 'invalid_video_card' } }
      const adapter = adapterFor(target), live = bindingFor(target)
      if (!adapter?.actions.sendVideoCard || !live || !isSameBinding(action.binding, live.binding)) return { state: 'failed', code: 'video_card_unavailable' }
      const binding = live.binding, expected = agentBindingToken(binding)
      const send = guardPendingSend(conversationAddressKey(target), () => isRunning() && conversationEnabled(target) && adapter.isReady() &&
        adapterFor(target) === adapter && !guard?.signal?.aborted && guard?.isCurrent?.() !== false && bindingIsCurrent(target, expected))
      try {
        if (!send.isCurrent()) return { state: 'failed', code: 'binding_changed' }
        try { return normalizeDeliveryReceipt(await adapter.actions.sendVideoCard({ version: 1, kind: 'video-card.send', target: binding.target, binding, card },
          { isCurrent: send.isCurrent, ...(guard?.signal ? { signal: guard.signal } : {}), ...(guard?.ensureCurrent ? { ensureCurrent: guard.ensureCurrent } : {}) })) }
        catch { return { state: 'unknown' } }
      } finally { send.release() }
    },
    async sendGroupLog(action, guard) {
      const target = action.target
      if (!groupLogEnabled || action.version !== 1 || action.kind !== 'group-log.upload' || !isConversationAddress(target) || target.kind !== 'group') return { state: 'failed', code: 'invalid_group_log' }
      let log: ReturnType<typeof validateAgentGroupLogArtifact>
      try { log = validateAgentGroupLogArtifact(action.log) } catch { return { state: 'failed', code: 'invalid_group_log' } }
      const adapter = adapterFor(target), live = bindingFor(target), source = action.source
      if (!adapter?.readMessage || !adapter.actions.sendGroupLog || !live || !isSameBinding(action.binding, live.binding) ||
          !isMessageId(source?.messageId) || !isPlatformAccount(source?.sender) || !samePlatformNamespace(source.sender, target.account) ||
          !Number.isSafeInteger(source.occurredAt) || source.occurredAt <= 0 || !/^[a-f\d]{64}$/u.test(source.textSha256)) return { state: 'failed', code: 'group_log_unavailable' }
      const binding = live.binding, token = agentBindingToken(binding)
      const send = guardPendingSend(conversationAddressKey(target), () => isRunning() && groupLogEnabled && adapter.isReady() &&
        adapterFor(target) === adapter && !guard?.signal?.aborted && guard?.isCurrent?.() !== false && bindingIsCurrent(target, token))
      try {
        if (!send.isCurrent() || !await inbox.canReply(target, source.messageId)) return { state: 'failed', code: 'source_unavailable' }
        const observed = await adapter.readMessage(target, source.messageId, { isCurrent: send.isCurrent, ...(guard?.signal ? { signal: guard.signal } : {}) })
        if (!observed || !sameTorrentSource(observed, target, source) || createHash('sha256').update(observed.text).digest('hex') !== source.textSha256 ||
            !send.isCurrent() || options.allowsText?.(log.name, 'outgoing') === false) return { state: 'failed', code: 'source_unavailable' }
        try { return normalizeFileDeliveryReceipt(await adapter.actions.sendGroupLog({ ...action, target: binding.target, binding, log },
          { isCurrent: send.isCurrent, ...(guard?.signal ? { signal: guard.signal } : {}) })) }
        catch { return { state: 'unknown' } }
      } finally { send.release() }
    },
    async sendRequesterArchive(action, guard) {
      const { target } = action
      if (action.version !== 1 || action.kind !== 'requester-archive.upload' || !isConversationAddress(target) || target.kind !== 'group') return { state: 'failed', code: 'invalid_requester_archive' }
      let archive: ReturnType<typeof validateAgentTorrentArchive>, source: SendRequesterArchiveAction['source']
      try {
        for (const [value, keys] of [[action, ['version', 'kind', 'target', 'binding', 'source', 'archive']],
          [action.source, ['messageId', 'sender', 'occurredAt', 'textSha256']]] as const) {
          if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
            Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key as never) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))) throw new Error('invalid')
        }
        archive = validateAgentTorrentArchive(action.archive)
        const original = action.source
        if (!isMessageId(original.messageId) || typeof original.textSha256 !== 'string' || !/^[a-f\d]{64}$/u.test(original.textSha256) ||
          !isPlatformAccount(original.sender) || !samePlatformNamespace(original.sender, target.account) ||
          !Number.isSafeInteger(original.occurredAt) || original.occurredAt <= 0 || [...adapters.values()].some(adapter =>
            samePlatformNamespace(adapter.account, original.sender) && [adapter.account.id, adapter.botUserId].includes(original.sender.id))) throw new Error('invalid')
        source = Object.freeze({ messageId: original.messageId, sender: Object.freeze({ ...original.sender }), occurredAt: original.occurredAt, textSha256: original.textSha256 })
        if (sanitizeFinalReplyText(archive.name) !== archive.name || options.allowsText?.(archive.name, 'outgoing') === false) throw new Error('invalid')
      } catch { return { state: 'failed', code: 'invalid_requester_archive' } }
      const adapter = adapterFor(target), live = bindingFor(target)
      if (!torrentCurrent() || !adapter?.readMessage || !adapter.actions.sendRequesterArchive || !live || !conversationEnabled(target)) return { state: 'failed', code: 'requester_archive_unavailable' }
      const binding = live.binding
      if (!isSameBinding(action.binding, binding)) return { state: 'failed', code: 'binding_changed' }
      const expected = agentBindingToken(binding), key = conversationAddressKey(target)
      const send = guardPendingSend(key, () => !guard?.signal?.aborted && torrentCurrent() && adapter.isReady() && adapterFor(target) === adapter &&
        conversationEnabled(target) && guard?.isCurrent?.() !== false && bindingIsCurrent(target, expected) && options.allowsText?.(archive.name, 'outgoing') !== false)
      try {
        if (!send.isCurrent() || !await inbox.canReply(target, source.messageId)) return { state: 'failed', code: 'source_unavailable' }
        const observed = await adapter.readMessage(target, source.messageId, { isCurrent: send.isCurrent })
        if (!observed || !sameTorrentSource(observed, target, source) || createHash('sha256').update(observed.text).digest('hex') !== source.textSha256 ||
          !send.isCurrent() || !await torrentSourceAllowed(observed, binding) || !send.isCurrent()) return { state: 'failed', code: 'source_unavailable' }
        try { return normalizeFileDeliveryReceipt(await adapter.actions.sendRequesterArchive({ version: 1, kind: 'requester-archive.upload', target: binding.target, binding, source, archive },
          { isCurrent: send.isCurrent, ...(guard?.signal ? { signal: guard.signal } : {}) })) }
        catch { return { state: 'unknown' } }
      } finally { send.release() }
    },
    async sendMediaRelay(action, guard) {
      const { target } = action
      if (action.version !== 1 || action.kind !== 'media-relay.send' || !isConversationAddress(target) ||
          action.mode !== 'forward' && action.mode !== 'direct-video') return { state: 'failed', code: 'invalid_media_relay' }
      const allowsText = (text: string) => sanitizeFinalReplyText(text) === text && options.allowsText?.(text, 'outgoing') !== false
      let plan: Readonly<AgentMediaRelayPlan>
      try { plan = validateAgentMediaRelayPlan(action.plan, { allowsText }) } catch { return { state: 'failed', code: 'invalid_media_relay' } }
      const texts = plan.items.map(item => item.parts.flatMap(part => part.kind === 'text' ? [part.text] : []).join('')).filter(Boolean), allText = texts.join('\n')
      if (!allowsText(allText) || texts.some(text => !allowsText(text))) return { state: 'failed', code: 'forbidden_text' }
      const targetKey = conversationAddressKey(target), adapter = adapterFor(target)
      let live: ResolvePersona | undefined
      try { live = bindingFor(target) } catch { return { state: 'failed', code: 'binding_unavailable' } }
      if (!adapter || !live || !isRunning() || !conversationEnabled(target)) return { state: 'failed', code: 'unbound_conversation' }
      const { binding } = live
      if (action.binding && !isSameBinding(action.binding, binding)) return { state: 'failed', code: 'binding_changed' }
      if (!adapter.isReady()) return { state: 'failed', code: 'account_disconnected' }
      if (!adapter.actions.sendMediaRelay) return { state: 'failed', code: 'media_relay_unavailable' }
      const expected = agentBindingToken(binding)
      const send = guardPendingSend(targetKey, () => !guard?.signal?.aborted && isRunning() && adapter.isReady() && adapterFor(target) === adapter &&
        conversationAddressKey(target) === targetKey && conversationEnabled(target) && guard?.isCurrent?.() !== false &&
        bindingIsCurrent(target, expected) && allowsText(allText) && texts.every(allowsText) && plan.items.every(item => item.parts.every(part => part.kind !== 'text' || allowsText(part.text))))
      try {
        if (!send.isCurrent()) return { state: 'failed', code: 'binding_changed' }
        try { return normalizeDeliveryReceipt(await adapter.actions.sendMediaRelay({ ...action, plan, binding },
          { isCurrent: send.isCurrent, ...(guard?.signal ? { signal: guard.signal } : {}), ...(guard?.ensureCurrent ? { ensureCurrent: guard.ensureCurrent } : {}) })) }
        catch { return { state: 'unknown' } }
      } finally { send.release() }
    },
    async sendAudioFile(action, guard) {
      const { target } = action
      if (action.version !== 1 || action.kind !== 'audio-file.upload' || !isConversationAddress(target)) return { state: 'failed', code: 'invalid_audio_file' }
      let attachment: AgentAudioAttachment
      try { attachment = validateAgentAudioAttachment(action.attachment) } catch { return { state: 'failed', code: 'invalid_audio_file' } }
      if (options.allowsText?.(attachment.name, 'outgoing') === false) return { state: 'failed', code: 'forbidden_audio_file' }
      const targetKey = conversationAddressKey(target), adapter = adapterFor(target)
      let live: ResolvePersona | undefined
      try { live = bindingFor(target) } catch { return { state: 'failed', code: 'binding_unavailable' } }
      if (!adapter || !live || !isRunning() || !conversationEnabled(target)) return { state: 'failed', code: 'unbound_conversation' }
      const { binding } = live
      if (action.binding && !isSameBinding(action.binding, binding)) return { state: 'failed', code: 'binding_changed' }
      if (!adapter.isReady()) return { state: 'failed', code: 'account_disconnected' }
      if (!adapter.actions.sendAudioFile) return { state: 'failed', code: 'audio_file_unavailable' }
      const expected = agentBindingToken(binding)
      const send = guardPendingSend(targetKey, () => !guard?.signal?.aborted && isRunning() && adapter.isReady() && adapterFor(target) === adapter &&
        conversationAddressKey(target) === targetKey && conversationEnabled(target) && guard?.isCurrent?.() !== false && bindingIsCurrent(target, expected))
      try {
        if (!send.isCurrent()) return { state: 'failed', code: 'binding_changed' }
        try { return normalizeFileDeliveryReceipt(await adapter.actions.sendAudioFile({ ...action, attachment, binding },
          { isCurrent: send.isCurrent, ...(guard?.signal ? { signal: guard.signal } : {}) })) }
        catch { return { state: 'unknown' } }
      } finally { send.release() }
    },
    async sendMusic(action, guard) {
      const { target } = action
      if (action.version !== 1 || action.kind !== 'music.send' || !isConversationAddress(target) || target.kind !== 'group') return { state: 'failed', code: 'invalid_music_target' }
      let music: AgentMusicCard
      try { music = validateAgentMusicCard(action.music) } catch { return { state: 'failed', code: 'invalid_music' } }
      if (Object.values(music).some(value => options.allowsText?.(value, 'outgoing') === false)) return { state: 'failed', code: 'forbidden_music' }
      const targetKey = conversationAddressKey(target), adapter = adapterFor(target)
      let live: ResolvePersona | undefined
      try { live = bindingFor(target) } catch { return { state: 'failed', code: 'binding_unavailable' } }
      if (!adapter || !live || !isRunning() || !conversationEnabled(target)) return { state: 'failed', code: 'unbound_conversation' }
      const { binding } = live
      if (action.binding && !isSameBinding(action.binding, binding)) return { state: 'failed', code: 'binding_changed' }
      if (!adapter.isReady()) return { state: 'failed', code: 'account_disconnected' }
      if (!adapter.actions.sendMusic) return { state: 'failed', code: 'music_delivery_unavailable' }
      const expected = agentBindingToken(binding)
      const send = guardPendingSend(targetKey, () => !guard?.signal?.aborted && isRunning() && adapter.isReady() && adapterFor(target) === adapter &&
        conversationAddressKey(target) === targetKey && conversationEnabled(target) && guard?.isCurrent?.() !== false && bindingIsCurrent(target, expected))
      try {
        if (!send.isCurrent()) return { state: 'failed', code: 'binding_changed' }
        try {
          const receipt = await adapter.actions.sendMusic({ ...action, music, binding }, { isCurrent: send.isCurrent, ...(guard?.signal ? { signal: guard.signal } : {}), ...(guard?.ensureCurrent ? { ensureCurrent: guard.ensureCurrent } : {}) })
          if (receipt.state === 'failed') return receipt
          if (receipt.state === 'sent' && isMessageId(receipt.messageId)) return receipt
        } catch { /* Native signing and send may continue after local cancellation. */ }
        return { state: 'unknown' }
      } finally { send.release() }
    },
    async sendMedia(action, guard) {
      const { target } = action
      if (action.version !== 1 || action.kind !== 'media.send' || !isConversationAddress(target)) return { state: 'failed', code: 'invalid_media' }
      let media: SendMediaAction['media']
      try { media = validateAgentMedia(action.media) } catch { return { state: 'failed', code: 'invalid_media' } }
      if (media.kind === 'audio' && media.spokenText !== undefined && options.allowsText?.(media.spokenText, 'outgoing') === false) return { state: 'failed', code: 'forbidden_text' }
      const targetKey = conversationAddressKey(target), adapter = adapterFor(target)
      let live: ResolvePersona | undefined
      try { live = bindingFor(target) } catch { return { state: 'failed', code: 'binding_unavailable' } }
      if (!adapter || !live || !isRunning() || !conversationEnabled(target)) return { state: 'failed', code: 'unbound_conversation' }
      const { binding } = live
      if (action.binding && !isSameBinding(action.binding, binding)) return { state: 'failed', code: 'binding_changed' }
      if (!adapter.isReady()) return { state: 'failed', code: 'account_disconnected' }
      if (!adapter.actions.sendMedia) return { state: 'failed', code: 'media_delivery_unavailable' }
      const expected = agentBindingToken(binding)
      const send = guardPendingSend(targetKey, () => !guard?.signal?.aborted && isRunning() && adapter.isReady() && adapterFor(target) === adapter &&
        conversationAddressKey(target) === targetKey && conversationEnabled(target) && guard?.isCurrent?.() !== false && bindingIsCurrent(target, expected))
      try {
        if (!send.isCurrent()) return { state: 'failed', code: 'binding_changed' }
        try {
          const receipt = await adapter.actions.sendMedia({ ...action, media, binding }, { isCurrent: send.isCurrent, ...(guard?.signal ? { signal: guard.signal } : {}), ...(guard?.ensureCurrent ? { ensureCurrent: guard.ensureCurrent } : {}) })
          if (receipt.state === 'failed') return receipt
          if (receipt.state === 'sent' && isMessageId(receipt.messageId)) return receipt
        } catch { /* The platform may already have accepted the media. */ }
        return { state: 'unknown' }
      } finally { send.release() }
    },
    async sendFile(action, guard) {
      const { target } = action
      if (action.version !== 1 || action.kind !== 'file.upload' || !isConversationAddress(target)) return { state: 'failed', code: 'invalid_file' }
      let file: AgentFileUpload
      try {
        file = validateAgentFileUpload(action.file)
        const text = agentFileUploadText(file)
        if (options.allowsText?.(file.name, 'outgoing') === false || text !== undefined && options.allowsText?.(text, 'outgoing') === false) return { state: 'failed', code: 'forbidden_text' }
      } catch { return { state: 'failed', code: 'invalid_file' } }
      const targetKey = conversationAddressKey(target), adapter = adapterFor(target)
      let live: ResolvePersona | undefined
      try { live = bindingFor(target) } catch { return { state: 'failed', code: 'binding_unavailable' } }
      if (!adapter || !live || !isRunning() || !conversationEnabled(target)) return { state: 'failed', code: 'unbound_conversation' }
      const { binding } = live
      if (action.binding && !isSameBinding(action.binding, binding)) return { state: 'failed', code: 'binding_changed' }
      if (!adapter.isReady()) return { state: 'failed', code: 'account_disconnected' }
      if (!adapter.actions.sendFile) return { state: 'failed', code: 'file_delivery_unavailable' }
      const expected = agentBindingToken(binding)
      const send = guardPendingSend(targetKey, () => !guard?.signal?.aborted && isRunning() && adapter.isReady() && adapterFor(target) === adapter &&
        conversationAddressKey(target) === targetKey && conversationEnabled(target) && guard?.isCurrent?.() !== false && bindingIsCurrent(target, expected))
      try {
        if (!send.isCurrent()) return { state: 'failed', code: 'binding_changed' }
        try { return normalizeFileDeliveryReceipt(await adapter.actions.sendFile({ ...action, file, binding }, { isCurrent: send.isCurrent, ...(guard?.signal ? { signal: guard.signal } : {}), ...(guard?.ensureCurrent ? { ensureCurrent: guard.ensureCurrent } : {}) })) }
        catch { return { state: 'unknown' } }
      } finally { send.release() }
    },
    async sendBundle(action, guard) {
      const { target } = action
      if (action.version !== 1 || action.kind !== 'message.bundle.send' || !isConversationAddress(target)) {
        return { state: 'failed', code: 'invalid_message' }
      }
      let items: readonly MessageBundleItem[]
      try { items = validateMessageBundle(action.items) } catch { return { state: 'failed', code: 'invalid_bundle' } }
      const targetKey = conversationAddressKey(target)
      const adapter = adapterFor(target)
      let live: ResolvePersona | undefined
      try { live = bindingFor(target) } catch { return { state: 'failed', code: 'binding_unavailable' } }
      if (!adapter || !live || !isRunning() || !conversationEnabled(target)) return { state: 'failed', code: 'unbound_conversation' }
      const { binding } = live
      if (action.binding && !isSameBinding(action.binding, binding)) return { state: 'failed', code: 'binding_changed' }
      if (!adapter.isReady()) return { state: 'failed', code: 'account_disconnected' }
      if (!adapter.actions.sendBundle) return { state: 'failed', code: 'bundle_delivery_unavailable' }
      const text = items.map(item => item.parts.flatMap(part => part.kind === 'text' ? [part.text] : []).join('')).join('\n')
      if (options.allowsText?.(text, 'outgoing') === false) return { state: 'failed', code: 'forbidden_text' }
      const expected = agentBindingToken(binding)
      const send = guardPendingSend(targetKey, () => isRunning() && adapter.isReady() && adapterFor(target) === adapter &&
        conversationAddressKey(target) === targetKey && conversationEnabled(target) && guard?.isCurrent?.() !== false && bindingIsCurrent(target, expected))
      try {
        if (!send.isCurrent()) return { state: 'failed', code: 'binding_changed' }
        try {
          const receipt = await adapter.actions.sendBundle({ ...action, items, binding }, { isCurrent: send.isCurrent, ...(guard?.ensureCurrent ? { ensureCurrent: guard.ensureCurrent } : {}) })
          if (receipt.state === 'failed') return receipt
          if (receipt.state === 'sent' && isMessageId(receipt.messageId)) return receipt
        } catch { /* A bundle may already have been accepted by the transport. */ }
        return { state: 'unknown' }
      } finally { send.release() }
    },
    async send(action, guard) {
      const { target, parts, replyTo } = action
      if (action.version !== 1 || action.kind !== 'message.send' || !isConversationAddress(target) || !parts.length) {
        return { state: 'failed', code: 'invalid_message' }
      }
      const targetKey = conversationAddressKey(target)
      const enabled = () => controlActions.has(action) || conversationEnabled(target)
      const adapter = adapterFor(target)
      let live: ResolvePersona | undefined
      try { live = bindingFor(target) } catch { return { state: 'failed', code: 'binding_unavailable' } }
      if (!adapter || !live || !isRunning() || !enabled()) return { state: 'failed', code: 'unbound_conversation' }
      const { binding } = live
      if (action.binding && !isSameBinding(action.binding, binding)) return { state: 'failed', code: 'binding_changed' }
      if (!adapter.isReady()) return { state: 'failed', code: 'account_disconnected' }
      if (parts.some(part => part.kind === 'mention' && part.user !== 'everyone' &&
          (!isPlatformAccount(part.user) || !samePlatformNamespace(target.account, part.user)) ||
          part.kind === 'extension' && part.platform !== target.account.platform)) {
        return { state: 'failed', code: 'part_scope_mismatch' }
      }
      const text = parts.flatMap(part => part.kind === 'text' ? [part.text] : []).join('')
      if (options.allowsText?.(text, 'outgoing') === false) return { state: 'failed', code: 'forbidden_text' }
      if (replyTo !== undefined && !isMessageId(replyTo)) return { state: 'failed', code: 'reply_source_unavailable' }
      const expected = agentBindingToken(binding)
      const send = guardPendingSend(targetKey, () => isRunning() && adapter.isReady() && adapterFor(target) === adapter &&
        conversationAddressKey(target) === targetKey && enabled() &&
        guard?.isCurrent?.() !== false && bindingIsCurrent(target, expected))
      try {
        if (replyTo !== undefined) {
          try { if (!await inbox.canReply(target, replyTo)) return { state: 'failed', code: 'reply_source_unavailable' } }
          catch { return { state: 'failed', code: 'reply_source_unavailable' } }
        }
        if (!send.isCurrent()) return { state: 'failed', code: 'binding_changed' }
        try {
          const ensureCurrent = async () => {
            if (!send.isCurrent()) throw new Error('消息来源已失效')
            await guard?.ensureCurrent?.()
            if (!send.isCurrent()) throw new Error('消息来源已失效')
          }
          await ensureCurrent()
          const receipt = await adapter.actions.send({ ...action, binding }, { isCurrent: send.isCurrent, ensureCurrent })
          if (receipt.state === 'failed') return receipt
          if (receipt.state === 'sent' && isMessageId(receipt.messageId)) return receipt
        } catch { /* Transport may have accepted the send before failing. */ }
        return { state: 'unknown' }
      } finally {
        send.release()
      }
    },
  }
  function instrumentActions(ai: boolean): MessageActionPort { return Object.fromEntries(Object.entries(rawMessageActions).map(([name, method]) => [name,
    (action: Parameters<MessageActionPort['send']>[0], guard: Parameters<MessageActionPort['send']>[1]) => {
      let binding: AgentBindingSnapshot | undefined
      const target = (action as unknown as { source?: { target?: ConversationAddress }; binding?: AgentBindingSnapshot })?.source?.target ??
        action?.target ?? (action as unknown as { binding?: AgentBindingSnapshot })?.binding?.target
      try { if (isConversationAddress(target)) binding = bindingFor(target)?.binding } catch { /* Invalid requests remain host-scoped. */ }
      const permission = ai && isConversationAddress(target) ? activity.capture(target) : undefined
      if (!ai && action && typeof action === 'object') controlActions.add(action)
      const current = () => (!permission || allowsConversationAI(target) && permission.isCurrent()) && guard?.isCurrent?.() !== false
      const originalSignal = (guard as { signal?: AbortSignal } | undefined)?.signal
      const signal = permission ? AbortSignal.any([permission.signal, ...(originalSignal ? [originalSignal] : [])]) : originalSignal
      return diagnostics.run(binding ? { kind: 'conversation', binding } : { kind: 'host' }, `send_${name}`, async () => {
          const receipt = await controlDelivery.run(!ai, () => method(action as never,
            { isCurrent: current, ...(signal ? { signal } : {}), ...(guard?.ensureCurrent ? { ensureCurrent: guard.ensureCurrent } : {}) }))
          const confirmed = receipt && typeof receipt === 'object' ? receipt as { state?: unknown; messageId?: unknown } : undefined
          // Requester archives and authentication notices use a different native
          // destination; their source conversation never acquires recall ownership.
          if (binding && name !== 'interact' && name !== 'sendRequesterArchive' && name !== 'sendRequesterBilibiliAuth' &&
              action.target && conversationAddressKey(action.target) === conversationAddressKey(binding.target) &&
              (confirmed?.state === 'sent' || confirmed?.state === 'uploaded') && isMessageId(confirmed.messageId) &&
              bindingIsCurrent(binding.target, agentBindingToken(binding))) {
            try { await outboundMessages.remember(binding, confirmed.messageId) }
            catch (error) { diagnostics.emit({ stage: 'delivery', operation: 'outbound_ownership', outcome: 'failed', code: 'ownership_not_recorded', error }) }
          }
          return receipt
        }, 'delivery').finally(() => { permission?.release(); if (!ai) controlActions.delete(action) })
    },
  ])) as unknown as MessageActionPort }
  const messageActions = instrumentActions(true)
  // Only the deterministic control workflow receives this closure; it is never exposed to tools.
  const controlMessageActions = instrumentActions(false)
  const gameHandlers: readonly AgentGroupGameHandler[] = Object.freeze([...(options.createGroupGames?.({
    async authorizeBackground(input) {
      try { return await authorizeGame(input.source, input.binding) } catch { return undefined }
    },
  }) ?? [])])
  if (new Set(gameHandlers.map(handler => handler.id)).size !== gameHandlers.length || gameHandlers.length > 2) throw new Error('重复或无效的群游戏入口')
  const gameHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  function gameCandidate(source: IncomingMessage): boolean {
    const binding = source.conversation.kind === 'group' ? bindingFor(source.conversation)?.binding : undefined
    return !!binding && gameHandlers.some(handler => handler.isCandidate(source, binding))
  }
  async function authorizeGame(original: IncomingMessage, owner: AgentBindingSnapshot): Promise<AgentGroupGameContext | undefined> {
    const source = structuredClone(original), binding = structuredClone(owner), target = binding.target
    const adapter = adapterFor(target), token = agentBindingToken(binding)
    const live = bindingFor(target)?.binding
    if (target.kind !== 'group' || !adapter?.readMessage || !live || !isMessageId(source.messageId) || source.sender.id === adapter.botUserId ||
        !hasValidInboundEvent({ kind: 'message', message: source }, adapter) || !isSameBinding(live, binding) ||
        conversationAddressKey(source.conversation) !== conversationAddressKey(target)) return undefined
    const signal = AbortSignal.any([toolCancellation.signal, ...(options.signal ? [options.signal] : [])])
    const fingerprint = agentDiceSourceFingerprint(source), operationId = gameHash(['group-game', agentConversationKey(binding), source.messageId])
    const current = () => observeCurrent(() => !signal.aborted && isRunning() &&
      adapterFor(target) === adapter && adapter.isReady() && bindingIsCurrent(target, token) && !privacyBlocked(platformAccountKey(target.account)))
    let role: 'owner' | 'admin' | 'member' | undefined, name = ''
    const ensureCurrent = async () => {
      if (!current() || options.allowsText?.(source.text, 'incoming') === false || options.allowsToolInput?.(source.text) === false ||
          !await inbox.canReply(target, source.messageId!) || await inbox.isRecalled(target, source.messageId!)) throw new Error('游戏来源已失效')
      const fresh = await adapter.readMessage!(target, source.messageId!, { signal, isCurrent: current })
      if (!fresh || agentDiceSourceFingerprint(fresh) !== fingerprint || !current()) throw new Error('游戏来源已改变')
      const observed = await readGroupMember(target, source.sender.id, signal, current)
      const bot = await readGroupMember(target, adapter.botUserId, signal, current)
      if (!observed || !bot || observed.member.role === 'unknown' || role !== undefined && observed.member.role !== role || !current()) throw new Error('游戏成员权限已改变')
      role ??= observed.member.role; name ||= observed.member.displayName
      const { botId, scene } = personMemoryAddress(target)
      const redactions = await personMemory.getRedactions({ identity: { botId, personaId: agentPersonaScopeId(binding.agentId) }, subjectId: source.sender.id })
      if (!current() || isPersonMemoryRedacted({ scene, messageId: source.messageId!, authorId: source.sender.id,
        at: source.occurredAt, excerpt: source.text.slice(0, 4000) }, source.text, redactions)) throw new Error('游戏来源已撤销')
    }
    await ensureCurrent()
    // A durable send attempt belongs to this original source and destination.
    // Unknown delivery is consumed; a repeated callback cannot replay it.
    const attempt = async (destination: string, content: string, send: () => Promise<{ state: string; messageId?: string }>, ensure = ensureCurrent) => {
      await ensure()
      const key = 'agent:game:send:' + gameHash([operationId, destination, content])
      if (await storage.set(key, 'unknown', { NX: true, PX: 30 * 86400_000 }) !== 'OK') throw new Error('游戏结果已有投递尝试')
      await ensure()
      const receipt = normalizeDeliveryReceipt(await send())
      if (receipt.state !== 'sent' || !isMessageId(receipt.messageId)) throw new Error('游戏结果投递尚未确认')
      await storage.set(key, 'sent', { PX: 30 * 86400_000 })
    }
    const clean = (value: string) => {
      if (typeof value !== 'string' || !value.trim() || value.length > 16000) throw new Error('游戏回复无效')
      const text = sanitizeFinalReplyText(value)
      if (!text.trim() || options.allowsToolInput?.(text) === false || options.allowsText?.(text, 'outgoing') === false) throw new Error('游戏回复不可发送')
      return text
    }
    const sending = (guard?: AgentGroupGameSendGuard) => ({
      signal: AbortSignal.any([signal, ...(guard?.signal ? [guard.signal] : [])]),
      isCurrent: () => current() && !guard?.signal?.aborted && guard?.isCurrent() !== false,
      async ensureCurrent() {
        if (guard?.signal?.aborted || guard?.isCurrent() === false) throw new Error('游戏回合已取消')
        await ensureCurrent(); await guard?.ensureCurrent()
        if (guard?.signal?.aborted || guard?.isCurrent() === false || !current()) throw new Error('游戏回合已取消')
      },
    })
    return Object.freeze({ source, binding, member: Object.freeze({ id: source.sender.id, name, role: role! }), signal,
      isCurrent: current, ensureCurrent,
      async sendText(value: string, guard?: AgentGroupGameSendGuard) {
        const text = clean(value), delivery = sending(guard)
        await attempt('group', text, () => controlMessageActions.send({ version: 1, kind: 'message.send', target, binding,
          replyTo: source.messageId!, parts: [{ kind: 'text', text }] }, delivery), delivery.ensureCurrent)
      },
      async sendImage(value: Parameters<AgentGroupGameContext['sendImage']>[0], guard?: AgentGroupGameSendGuard) {
        const image = validateAgentToolImage(value), delivery = sending(guard)
        await attempt('group-image', gameHash(image), () => controlMessageActions.send({ version: 1, kind: 'message.send', target, binding,
          replyTo: source.messageId!, parts: [{ kind: 'image', resource: { kind: 'reference', value: 'base64://' + image.base64 } }] }, delivery), delivery.ensureCurrent)
      },
      async sendPrivate(userId: string, value: string, guard?: AgentGroupGameSendGuard) {
        const text = clean(value), delivery = sending(guard)
        if (!isPlatformIdentifier(userId) || userId === adapter.botUserId) throw new Error('游戏私发对象无效')
        const ensure = async () => { await delivery.ensureCurrent(); if (!await readGroupMember(target, userId, delivery.signal, delivery.isCurrent)) throw new Error('游戏私发对象不在原群'); await delivery.ensureCurrent() }
        await ensure()
        await attempt('private:' + userId, text, () => controlMessageActions.sendGamePrivate!({ binding, source,
          origin: { binding, source: { messageId: source.messageId!, author: source.sender, occurredAt: source.occurredAt, fingerprint },
            operationId, authorityRevision: gameHash(['game-authority', token]) },
          recipient: { ...target.account, id: userId }, text, operationId, index: 0 }, { signal: delivery.signal, isCurrent: delivery.isCurrent, ensureCurrent: ensure }), ensure)
      },
    })
  }
  async function handleGames(source: IncomingMessage, binding: AgentBindingSnapshot): Promise<boolean> {
    if (binding.target.kind !== 'group') return false
    for (const handler of gameHandlers) {
      if (!handler.isCandidate(source, binding)) continue
      try {
        const context = await authorizeGame(source, binding)
        if (!context) return true
        await context.ensureCurrent()
        const key = 'agent:game:action:' + gameHash([handler.id, agentConversationKey(binding), source.messageId])
        if (await storage.set(key, 'unknown', { NX: true, PX: 30 * 86400_000 }) !== 'OK') return true
        await context.ensureCurrent()
        const consumed = await handler.handle(context)
        await context.ensureCurrent()
        await storage.set(key, consumed ? 'completed' : 'ignored', { PX: 30 * 86400_000 })
        if (consumed) return true
      } catch (error) {
        diagnostics.emit({ stage: 'runtime', operation: 'group_game', outcome: 'failed', error })
        return true
      }
    }
    return false
  }
  const workflowDiagnostics = {
    diagnostics,
    withDiagnosticScope: diagnostics.run,
    explainFailure: (input: { detail: string; isCurrent: () => boolean | Promise<boolean>; signal?: AbortSignal }) => generateAgentFailureNotice({
      stage: 'runtime', outcome: 'failed', detail: input.detail, diagnostics,
      isCurrent: () => isRunning() && !input.signal?.aborted ? input.isCurrent() : false,
      allowsText: text => options.allowsText?.(text, 'outgoing') !== false,
      ...(options.failureNoticeFallback ? { fallbackText: options.failureNoticeFallback } : {}),
      model: request => options.YTapi(request, options.getExecutionConfig?.() ?? {}, input.signal,
        () => isRunning() && !input.signal?.aborted,
        async () => { if (!isRunning() || input.signal?.aborted || !await input.isCurrent()) throw new Error('失败说明来源已失效') }),
    }),
  }
  async function groupLogAuthorized(message: IncomingMessage, binding: AgentBindingSnapshot, signal: AbortSignal, guard: () => boolean): Promise<boolean> {
    if (!guard() || signal.aborted || !bindingIsCurrent(binding.target, agentBindingToken(binding))) return false
    if (options.groupLog?.masters?.some(user => platformAccountKey(user) === platformAccountKey(message.sender))) return true
    const observed = await readGroupMember(binding.target, message.sender.id, signal, guard)
    return guard() && !signal.aborted && !!observed && (observed.member.role === 'owner' || observed.member.role === 'admin')
  }
  const groupLogWorkflow = createAgentGroupLogWorkflow({
    store: groupLogs, render: createAgentGroupLogRenderer({ ...(options.groupLog?.maxBytes ? { maxBytes: options.groupLog.maxBytes } : {}),
      allowsText: text => options.allowsText?.(text, 'outgoing') !== false }),
    diagnostics, isRunning, resolveBinding: target => bindingFor(target)?.binding,
    isBindingCurrent: binding => !privacyBlocked(platformAccountKey(binding.target.account)) && bindingIsCurrent(binding.target, agentBindingToken(binding)),
    authorized: groupLogAuthorized, canReply: inbox.canReply,
    allowsText: text => options.allowsText?.(text, 'incoming') !== false && options.allowsText?.(text, 'outgoing') !== false,
    async sourceAllowed(row, owner) {
      const { botId, scene } = personMemoryAddress(owner.target)
      const redactions = await personMemory.getRedactions({ identity: { botId, personaId: agentPersonaScopeId(owner.agentId) }, subjectId: row.authorId })
      return options.allowsText?.(row.content, 'incoming') !== false && options.allowsText?.(row.name, 'incoming') !== false &&
        !isPersonMemoryRedacted({ scene, messageId: row.messageId, authorId: row.authorId, at: row.occurredAt, excerpt: row.content.slice(0, 4000) }, row.content, redactions)
    },
    actions: controlMessageActions, setAI: setConversationAI,
    async failureNotice(input) {
      if (!allowsConversationAI(input.target)) return undefined
      const permission = activity.capture(input.target)
      try { return await workflowDiagnostics.explainFailure({ ...input, signal: AbortSignal.any([input.signal, permission.signal]),
        isCurrent: async () => permission.isCurrent() && allowsConversationAI(input.target) && await input.isCurrent() }) }
      finally { permission.release() }
    },
    ...(options.now ? { now: options.now } : {}),
  })
  const diceWorkflow = createAgentDiceWorkflow(diceConfig, { ledger: diceLedger, actions: controlMessageActions, diagnostics,
    allowsText: text => options.allowsText?.(text, 'outgoing') !== false && options.allowsToolInput?.(text) !== false })
  const diceBridge = options.diceEngine?.enabled ? createAgentDiceHostBridge(options.diceEngine, {
    state: diceState, legacyLedger: diceLedger, diagnostics,
    allowsText: text => options.allowsText?.(text, 'outgoing') !== false && options.allowsToolInput?.(text) !== false,
    async readGrant(request, guard) { return options.readDiceGrant?.(request, guard) },
    async readMessage({ binding, messageId }, guard) {
      const adapter = adapterFor(binding.target)
      await guard.ensureCurrent?.()
      if (!guard.isCurrent() || !adapter?.isReady() || !bindingIsCurrent(binding.target, agentBindingToken(binding))) return undefined
      const result = await adapter.readMessage?.(binding.target, messageId, { signal: guard.signal, isCurrent: guard.isCurrent })
      await guard.ensureCurrent?.()
      return guard.isCurrent() && adapterFor(binding.target) === adapter ? result : undefined
    },
    async readMembers({ binding }, guard) {
      await guard.ensureCurrent?.()
      return readGroupMembers(binding.target, guard.signal, () => diceCurrent() && guard.isCurrent() && bindingIsCurrent(binding.target, agentBindingToken(binding)))
    },
    async sourceAllowed({ binding, source }, guard) {
      if (!guard.isCurrent() || !diceCurrent() || !source.messageId || !bindingIsCurrent(binding.target, agentBindingToken(binding)) ||
          options.allowsText?.(source.text, 'incoming') === false || options.allowsToolInput?.(source.text) === false ||
          !await inbox.canReply(binding.target, source.messageId) || await inbox.isRecalled(binding.target, source.messageId)) return false
      const { botId, scene } = personMemoryAddress(binding.target)
      const redactions = await personMemory.getRedactions({ identity: { botId, personaId: agentPersonaScopeId(binding.agentId) }, subjectId: source.sender.id })
      return guard.isCurrent() && diceCurrent() && !isPersonMemoryRedacted({ scene, messageId: source.messageId,
        authorId: source.sender.id, at: source.occurredAt, excerpt: source.text.slice(0, 4000) }, source.text, redactions)
    },
    async sendPublic({ binding, source, text }, guard) {
      const receipt = await controlMessageActions.send({ version: 1, kind: 'message.send', target: binding.target, binding,
        replyTo: source.messageId!, parts: [{ kind: 'text', text }] }, { isCurrent: guard.isCurrent,
        ensureCurrent: async () => { await guard.ensureCurrent?.() } })
      return receipt.state === 'sent' && isMessageId(receipt.messageId) ? { state: 'sent', messageId: receipt.messageId } :
        { state: receipt.state === 'failed' ? 'failed' : 'unknown' }
    },
    async relayPrivate(request, guard) {
      const receipt = await controlMessageActions.sendDicePrivate!(request, guard)
      return receipt.state === 'sent' && isMessageId(receipt.messageId) ? { state: 'sent', messageId: receipt.messageId } :
        { state: receipt.state === 'failed' ? 'failed' : 'unknown' }
    },
    async setGroupCard({ binding, source, subject, name }, guard) {
      const target = binding.target, adapter = adapterFor(target), token = agentBindingToken(binding)
      if (!adapter?.actions.interact || options.allowsText?.(name, 'outgoing') === false || options.allowsToolInput?.(name) === false) return { state: 'failed' }
      const pending = guardPendingSend(conversationAddressKey(target), () => diceCurrent() && guard.isCurrent() && !guard.signal.aborted &&
        adapterFor(target) === adapter && adapter.isReady() && conversationEnabled(target) && bindingIsCurrent(target, token))
      const ensureCurrent = async () => {
        if (!pending.isCurrent()) throw new Error('骰子群名片来源已失效')
        await guard.ensureCurrent?.()
        if (!pending.isCurrent()) throw new Error('骰子群名片来源已失效')
      }
      try {
        await ensureCurrent()
        const receipt = await diagnostics.run({ kind: 'conversation', binding, messageId: source.messageId! }, 'dice_group_card', () =>
          controlDelivery.run(true, () => adapter.actions.interact!({ version: 1, kind: 'conversation.interact', target, binding,
            interaction: { kind: 'member-card', user: subject, name, requester: source.sender } },
          { signal: guard.signal, isCurrent: pending.isCurrent, ensureCurrent })), 'delivery')
        return { state: receipt.state === 'confirmed' ? 'confirmed' : receipt.state === 'failed' ? 'failed' : 'unknown' }
      } catch { return { state: 'unknown' } }
      finally { pending.release() }
    },
    async controlLog({ binding, source, operation, ownershipId, title, operationId, index }, guard) {
      if (!groupLogEnabled || !source.messageId || title !== undefined &&
          (options.allowsText?.(title, 'outgoing') === false || options.allowsToolInput?.(title) === false)) return { state: 'failed' }
      await guard.ensureCurrent?.()
      const epochs = await groupLogs.capture({ target: binding.target, agentId: binding.agentId }, source.sender.id)
      await guard.ensureCurrent?.()
      if (!guard.isCurrent() || !diceCurrent()) return { state: 'failed' }
      const receipt = await groupLogs.controlDiceLog({ target: binding.target, agentId: binding.agentId }, {
        sourceMessageId: source.messageId, subjectId: source.sender.id, operation, ownershipId, operationId, index,
        ...(title === undefined ? {} : { title }),
      }, options.now?.() ?? Date.now(), epochs)
      await guard.ensureCurrent?.()
      if (!guard.isCurrent() || !diceCurrent()) return { state: 'unknown' }
      await groupLogWorkflow.restore(binding.target, binding)
      await guard.ensureCurrent?.()
      return guard.isCurrent() ? { state: receipt.state } : { state: 'unknown' }
    },
    ...(options.now ? { now: options.now } : {}),
  }) : undefined
  const dicePolicy = createHash('sha256').update(JSON.stringify([diceConfigKey, diceBridge?.definitionId ?? null])).digest('hex')
  const diceCandidate = (message: IncomingMessage) => diceBridge ? diceBridge.isCandidate(message) : diceWorkflow.isCandidate(message)
  async function handleDice(incoming: IncomingMessage, binding: AgentBindingSnapshot,
    epochs: import('../modules/dice/infrastructure/agentGroupLogStore.js').AgentGroupLogEpochs): Promise<boolean> {
    if (!diceCandidate(incoming)) return false
    const target = binding.target, adapter = adapterFor(target), token = agentBindingToken(binding)
    if (!incoming.messageId || !adapter?.readMessage) return true
    const memoryTurn = await beginMemoryTurn(binding, false)
    const current = () => diceCurrent() && memoryTurn.isCurrent() && conversationEnabled(target) &&
      adapterFor(target) === adapter && adapter.isReady() && bindingIsCurrent(target, token)
    const ensureAdmission = async () => {
      const latest = await groupLogs.capture({ target, agentId: binding.agentId }, incoming.sender.id)
      if (!current() || latest.globalEpoch !== epochs.globalEpoch || latest.sceneEpoch !== epochs.sceneEpoch) throw new Error('骰子入站隐私权限已改变')
    }
    const ensure = async () => {
      if (!current() || !await inbox.canReply(target, incoming.messageId!) || await inbox.isRecalled(target, incoming.messageId!)) throw new Error('骰子来源已失效')
      await ensureAdmission()
      const fresh = await adapter.readMessage!(target, incoming.messageId!, { isCurrent: current, signal: memoryTurn.signal })
      if (!fresh || !isConversationAddress(fresh.conversation) || conversationAddressKey(fresh.conversation) !== conversationAddressKey(target) ||
          fresh.messageId !== incoming.messageId || !isPlatformAccount(fresh.sender) || platformAccountKey(fresh.sender) !== platformAccountKey(incoming.sender) ||
          fresh.occurredAt !== incoming.occurredAt || fresh.text !== incoming.text ||
          (diceBridge ? agentDiceSourceFingerprint(fresh) !== agentDiceSourceFingerprint(incoming) :
            fresh.quote || fresh.mentions.length || fresh.parts.some(part => part.kind !== 'text') ||
            fresh.parts.map(part => part.kind === 'text' ? part.text : '').join('') !== incoming.text) ||
          options.allowsText?.(fresh.text, 'incoming') === false || options.allowsToolInput?.(fresh.text) === false || !current()) throw new Error('骰子来源已改变')
      const { botId, scene } = personMemoryAddress(target)
      const redactions = await personMemory.getRedactions({ identity: { botId, personaId: agentPersonaScopeId(binding.agentId) }, subjectId: incoming.sender.id })
      if (!current() || !await inbox.canReply(target, incoming.messageId!) || await inbox.isRecalled(target, incoming.messageId!) ||
          isPersonMemoryRedacted({ scene, messageId: incoming.messageId!, authorId: incoming.sender.id, at: incoming.occurredAt,
            excerpt: incoming.text.slice(0, 4000) }, incoming.text, redactions)) throw new Error('骰子来源权限已失效')
      await ensureAdmission()
    }
    try {
      const context: AgentDiceEngineContext = { signal: memoryTurn.signal, isCurrent: current, ensureCurrent: ensure }
      if (groupLogEnabled) {
        const owner = { target, agentId: binding.agentId }
        const log = diceBridge ? await groupLogs.read(owner) : undefined
        if (log) await ensure()
        Object.assign(context, {
          ...(log ? { logActive: log.active } : {}),
          async archive(result: { readonly eventId: string; readonly text: string; readonly deliveryMessageId: string }) {
            await ensure()
            const name = incoming.senderName || incoming.sender.id
            if (options.allowsText?.(result.text, 'outgoing') === false || options.allowsToolInput?.(result.text) === false ||
                options.allowsText?.(name, 'incoming') === false) throw new Error('骰子团录内容已失效')
            await groupLogs.append(owner, { messageId: incoming.messageId!, authorId: incoming.sender.id,
              occurredAt: incoming.occurredAt, name, content: result.text, type: 'dice_result',
              eventId: result.eventId, deliveryMessageId: result.deliveryMessageId }, epochs)
          },
          async record(event: Parameters<NonNullable<AgentDiceEngineContext['record']>>[0]) {
            await ensure()
            if (event.producer !== 'agent-dice-engine' || !['card_change', 'rule_event'].includes(event.kind) ||
                event.source.messageId !== incoming.messageId || event.source.authorId !== incoming.sender.id ||
                event.source.at !== incoming.occurredAt) throw new Error('骰子规则事件来源无效')
            if (event.facts && typeof event.facts === 'object' && !Array.isArray(event.facts) &&
                (event.facts as Readonly<Record<string, unknown>>).visibility === 'private') return
            const content = JSON.stringify(event.facts), name = incoming.senderName || incoming.sender.id
            if (options.allowsText?.(content, 'outgoing') === false || options.allowsToolInput?.(content) === false ||
                options.allowsText?.(name, 'incoming') === false) throw new Error('骰子规则事件内容已失效')
            await groupLogs.append(owner, { messageId: incoming.messageId!, authorId: incoming.sender.id,
              occurredAt: incoming.occurredAt, name, content, type: 'dice_rule', eventId: event.eventId }, epochs)
          },
        })
      }
      return await diagnostics.run({ kind: 'conversation', binding, messageId: incoming.messageId }, 'dice_command', () =>
        (diceBridge ?? diceWorkflow).handle(incoming, binding, context), 'runtime')
    } finally { memoryTurn.release() }
  }
  function bilibiliQualityCurrent(): boolean {
    try { return options.bilibiliQuality?.enabled === true && options.isBilibiliQualityCurrent?.() !== false && isRunning() }
    catch { return false }
  }
  const bilibiliQuality = options.bilibiliQuality?.enabled && options.bilibiliAuthService ? createAgentBilibiliQualityWorkflow(options.bilibiliQuality, {
    storage, auth: options.bilibiliAuthService, provider: binding => options.bilibiliQualityProviderFor?.(binding), actions: controlMessageActions,
    diagnostics, allowsText: text => options.allowsText?.(text, 'incoming') !== false && options.allowsText?.(text, 'outgoing') !== false,
    explainFailure: async input => {
      await input.ensureCurrent()
      if (!allowsConversationAI(input.binding.target)) return undefined
      return workflowDiagnostics.explainFailure(input)
    },
    ...(options.now ? { now: options.now } : {}),
  }) : undefined
  const extraction = createAgentMusicExtraction({
    ...workflowDiagnostics,
    ...(options.musicExtraction ? { config: options.musicExtraction } : {}), storage, actions: messageActions,
    ...(options.musicExtractionProvider ? { provider: options.musicExtractionProvider } : {}),
    allowsText: text => options.allowsText?.(text, 'outgoing') !== false,
    ...(options.now ? { now: options.now } : {}),
    async readShare(incoming, sourceId, context) {
      const adapter = adapterFor(incoming.conversation)
      if (!adapter?.readMusicShare || !context.isCurrent()) return undefined
      return await adapter.readMusicShare(incoming.conversation, sourceId, {
        signal: context.signal, isCurrent: context.isCurrent, allowsSource: context.allowsSource,
      })
    },
  })
  const mediaOutbox = createAgentMediaOutbox({
    ...workflowDiagnostics,
    storage, actions: messageActions, ...(options.mediaRelayProvider ? { provider: options.mediaRelayProvider } : {}),
    allowsText: text => options.allowsText?.(text, 'outgoing') !== false,
    ...(options.now ? { now: options.now } : {}), openContext: openMediaRelayContext,
  })
  const torrent = createAgentTorrentWorkflow({ config: torrentConfig, storage, actions: messageActions,
    ...workflowDiagnostics,
    ...(options.torrentProvider ? { provider: options.torrentProvider } : {}),
    ...(options.renderTorrentListing ? { renderListing: options.renderTorrentListing } : {}),
    ...(options.now ? { now: options.now } : {}), allowsText: text => options.allowsText?.(text, 'outgoing') !== false,
    isCurrent: torrentCurrent, responsible: torrentResponsible, openContext: openTorrentContext,
  })
  const allowsFileNames = (message: IncomingMessage) => message.parts.every(part => part.kind !== 'file' || !part.name || options.allowsText?.(part.name, 'incoming') !== false)
  const memberTools = options.adapters.some(adapter => adapter.readConversationMember || adapter.listConversationMembers) ? createAgentMemberTools() : []
  const historyTools = options.history?.enabled === true ? [createAgentHistoryTool()] : []
  const interactionTools = createAgentInteractionTools({ enabled: options.interactions?.enabled === true })
  const interactionWorkflow = createAgentInteractionWorkflow(storage, { diagnostics })
  function interactionsCurrent(): boolean { return options.interactions?.enabled === true && options.isInteractionsCurrent?.() !== false }
  async function performInteractions(input: Parameters<NonNullable<SimulationRuntimePorts['performInteractions']>>[0]): Promise<AgentInteractionResult> {
    const { target, binding, source, signal, plan } = input
    const peer = target.kind === 'private' ? privatePeerFor(target) : undefined
    const current = () => interactionsCurrent() && !signal.aborted && input.isCurrent() && isRunning() &&
      allowsConversationAI(target) && conversationEnabled(target) && bindingIsCurrent(target, agentBindingToken(binding)) && !!adapterFor(target)?.actions.interact &&
      (target.kind !== 'private' || !!peer && privatePeerFor(target) === peer && source?.author.id === peer &&
        options.privateTextTools?.includes(plan.kind === 'profile-like' ? 'likeTool' : 'recallTool') === true &&
        (plan.kind === 'profile-like' || plan.kind === 'message-recall'))
    const sourceAllowed = async (messageId: string, expected?: typeof source): Promise<boolean> => {
      const adapter = adapterFor(target)
      if (!adapter?.readMessage || !current() || !await inbox.canReply(target, messageId) || await inbox.isRecalled(target, messageId)) return false
      const message = await adapter.readMessage(target, messageId, { isCurrent: current })
      if (!message || !isConversationAddress(message.conversation) || conversationAddressKey(message.conversation) !== conversationAddressKey(target) ||
          message.messageId !== messageId || !isPlatformAccount(message.sender) || !samePlatformNamespace(message.sender, target.account) ||
          !Number.isSafeInteger(message.occurredAt) || message.occurredAt <= 0 || matchPersonMemoryCommand(message.text) || !allowsFileNames(message) || options.allowsText?.(message.text, 'incoming') === false ||
          options.allowsToolInput?.(message.text) === false || expected && (platformAccountKey(message.sender) !== platformAccountKey(expected.author) ||
            message.text !== expected.text || message.occurredAt !== expected.occurredAt)) return false
      const { botId, scene } = personMemoryAddress(target, peer), excerpt = message.text || '[互动来源]'
      const redactions = await personMemory.getRedactions({ identity: { botId, personaId: agentPersonaScopeId(binding.agentId) }, subjectId: message.sender.id })
      return current() && await inbox.canReply(target, messageId) && !await inbox.isRecalled(target, messageId) &&
        !isPersonMemoryRedacted({ scene, messageId, authorId: message.sender.id, at: message.occurredAt, excerpt }, excerpt, redactions)
    }
    const ensure = async () => {
      if (!current()) throw new Error('互动所属回合已失效')
      await input.ensureCurrent()
      if (source && !await sourceAllowed(source.messageId, source) || !current()) throw new Error('互动请求来源已失效')
    }
    const result = await interactionWorkflow.execute({ binding, identity: input.identity, plan, signal, isCurrent: current, ensureCurrent: ensure,
      async validateOperation(operation: AgentInteraction) {
        await ensure()
        if (isAgentGroupManagement(operation)) {
          const adapter = adapterFor(target)
          if (target.kind !== 'group' || !source || !adapter?.readConversationMember ||
              platformAccountKey(operation.requester) !== platformAccountKey(source.author) ||
              operation.kind === 'member-card' && (options.allowsText?.(operation.name, 'outgoing') === false || options.allowsToolInput?.(operation.name) === false)) return false
          const requester = await readGroupMember(target, source.author.id, signal, current)
          if (!requester || !current()) return false
          const bot = await readGroupMember(target, adapter.botUserId, signal, current)
          if (!bot || !current()) return false
          const member = operation.kind === 'group-mute' ? undefined : await readGroupMember(target, operation.user.id, signal, current)
          return current() && canApplyGroupManagement(operation, requester.member, bot.member, member?.member)
        }
        if (operation.kind === 'message-recall') {
          const adapter = adapterFor(target)
          if (!adapter?.readOwnMessage || !await outboundMessages.owns(binding, operation.messageId) ||
              await inbox.isRecalled(target, operation.messageId) || !current()) return false
          const proof = await adapter.readOwnMessage(target, operation.messageId, { signal, isCurrent: current })
          return !!proof && isConversationAddress(proof.conversation) && conversationAddressKey(proof.conversation) === conversationAddressKey(target) &&
            proof.messageId === operation.messageId && isPlatformAccount(proof.author) && samePlatformNamespace(proof.author, target.account) &&
            proof.author.id === adapter.botUserId && Number.isSafeInteger(proof.occurredAt) && proof.occurredAt > 0 && proof.occurredAt <= Date.now() + 60_000 &&
            current() && await outboundMessages.owns(binding, operation.messageId) && !await inbox.isRecalled(target, operation.messageId) && current()
        }
        if (target.kind === 'private') return operation.kind === 'profile-like' && operation.user.id === peer &&
          samePlatformNamespace(operation.user, target.account) && privatePeerFor(target) === peer && current()
        return operation.kind === 'message-reaction' ? sourceAllowed(operation.messageId) :
          !!await readGroupMember(target, operation.user.id, signal, current) && current()
      },
      dispatch: (action, guard) => messageActions.interact!(action, guard),
    })
    // Apply the same source revocation as a platform recall notification, even
    // when durable settlement failed after the native delete was confirmed.
    if (plan.kind === 'message-recall' && result.completed > 0) {
      const operation = plan.operations[0], adapter = adapterFor(target)
      if (operation?.kind === 'message-recall' && adapter) try {
        await acceptEvent(adapter, { kind: 'recall', target, messageId: operation.messageId })
      } catch (error) {
        diagnostics.emit({ stage: 'delivery', operation: 'interaction', outcome: 'unknown', code: 'recall_invalidation_failed', error })
        return { state: 'unknown', completed: result.completed, requested: result.requested, code: 'interaction_settlement_failed' }
      }
    }
    return result
  }
  const qqActionsCurrent = (binding: AgentBindingSnapshot) => checkToolCurrent(() =>
    isRunning() && options.isQqActionsCurrent?.() !== false && binding.target.kind === 'group' &&
    conversationEnabled(binding.target) && allowsConversationAI(binding.target) &&
    bindingIsCurrent(binding.target, agentBindingToken(binding)) && adapterFor(binding.target)?.isReady() === true)
  const qqActions = createAgentQqActions({
    ...(options.qqActions ? { config: options.qqActions } : {}), storage, adapterFor, isCurrent: qqActionsCurrent, checkCurrent: checkToolCurrent,
    ...(options.observeExecutionCurrent ? { observeCurrent } : {}),
    authorize(name, binding, actor) {
      if (!qqActionsCurrent(binding) || actor.kind === 'commitment') return false
      const config = defaultSimRuntimeConfig(options.getSection())
      if (textInboxFor(binding.target)) return actor.kind === 'user' && (options.groupTextTools?.(binding.target) ?? []).some(tool => String(tool) === name)
      return resolveSimToolSurface({ policy: config.toolPolicy, builtInNames: [name], extraTools: config.extraTools, groupId: binding.target.id }).includes(name)
    },
    async sourceAvailable(binding, source, guard) {
      const target = binding.target, adapter = adapterFor(target)
      const current = () => checkToolCurrent(() => guard.isCurrent() && !guard.signal.aborted && qqActionsCurrent(binding) && adapterFor(target) === adapter)
      try {
        if (!adapter?.readMessage || !current() || !isMessageId(source.messageId) || !isPlatformAccount(source.author) ||
            !samePlatformNamespace(source.author, target.account) || await inbox.isRecalled(target, source.messageId)) return false
        const fresh = await adapter.readMessage(target, source.messageId, { isCurrent: current })
        if (!fresh || conversationAddressKey(fresh.conversation) !== conversationAddressKey(target) || fresh.messageId !== source.messageId ||
            platformAccountKey(fresh.sender) !== platformAccountKey(source.author) || !current() ||
            options.allowsText?.(fresh.text, 'incoming') === false || options.allowsToolInput?.(fresh.text) === false) return false
        const { botId, scene } = personMemoryAddress(target), excerpt = fresh.text || '[QQ扩展来源]'
        const redactions = await personMemory.getRedactions({ identity: { botId, personaId: agentPersonaScopeId(binding.agentId) }, subjectId: source.author.id })
        return current() && !await inbox.isRecalled(target, source.messageId) &&
          !isPersonMemoryRedacted({ scene, messageId: source.messageId, authorId: source.author.id, at: fresh.occurredAt, excerpt }, excerpt, redactions)
      } catch { return false }
    },
    allowsText: text => options.allowsText?.(text, 'outgoing') !== false && options.allowsToolInput?.(text) !== false,
    getQzoneLimits: () => defaultSimRuntimeConfig(options.getSection()).qzone,
    diagnostics, ...(options.now ? { now: options.now } : {}),
  })
  const supportsQqAction = (target: ConversationAddress, name: string): boolean => checkToolCurrent(() => {
    const adapter = adapterFor(target), binding = bindingFor(target)?.binding
    if (!binding || !qqActionsCurrent(binding)) return false
    if (name === 'sendGiftTool') return options.qqActions?.gift?.enabled === true && !!adapter?.gift
    if (name === 'grabRedBagTool') return options.qqActions?.redPackets?.enabled === true && options.qqActions.redPackets.allowExplicit === true && !!adapter?.redPackets
    return name === 'qqZoneTool' ? options.qqActions?.qzone?.enabled === true && !!adapter?.qzone
      : name === 'simQzoneInteract' && options.getSection().qzone?.enabled === true && !!adapter?.qzone
  })
  const deferredHostCurrent = () => isRunning() && options.isDeferredActionsCurrent?.() !== false
  const deferredMode = (target: ConversationAddress): 'simulation' | 'text' | 'private' | undefined => {
    if (!isRunning() || !conversationEnabled(target) || !adapterFor(target)?.isReady() || !bindingFor(target)) return undefined
    return target.kind === 'private' ? 'private' : textInboxFor(target) ? 'text' : 'simulation'
  }
  const deferredPoke = createAgentDeferredPokeDefinition({
    definitionId: AGENT_DEFERRED_POKE_DEFINITION_ID,
    isCurrent: () => deferredHostCurrent() && interactionsCurrent(),
    readMember: (id, context) => readGroupMember(context.binding.target, id, context.signal, context.isCurrent),
    perform: (plan, context) => performInteractions({ target: context.binding.target, binding: context.binding,
      identity: `deferred:${context.taskId}:${context.delegation.id}`, plan, signal: context.signal,
      isCurrent: context.isCurrent, ensureCurrent: context.ensureCurrent }),
  })
  const deferredExecutor = createAgentDeferredActionExecutor({
    getDefinitions: () => [deferredPoke, ...(options.getDeferredActionDefinitions?.() ?? [])],
  })
  const deferredAuthorization = createAgentDeferredActionPolicy({
    getConfig: () => deferredHostCurrent() ? options.deferredActions : undefined,
    resolveDefinition: deferredExecutor.resolve, mode: deferredMode,
    isToolAllowed(request) {
      if (!deferredHostCurrent() || !allowsConversationAI(request.binding.target)) return false
      const config = defaultSimRuntimeConfig(options.getSection())
      return resolveSimToolSurface({ policy: config.toolPolicy, builtInNames: ['pokeTool', ...(options.toolRegistry?.builtIn ?? []).map(tool => tool.name)],
        extraTools: config.extraTools, groupId: request.binding.target.id }).includes(request.action.tool)
    },
    async verifyAuthority({ phase, request, signal, isCurrent }) {
      const { binding, creator, source } = request, target = binding.target, adapter = adapterFor(target)
      const current = () => !signal.aborted && isCurrent() && deferredHostCurrent() && allowsConversationAI(target) &&
        !privacyBlocked(platformAccountKey(target.account)) && deferredMode(target) === 'simulation' &&
        bindingIsCurrent(target, agentBindingToken(binding)) && adapterFor(target) === adapter
      try {
        if (!adapter || !current() || !isPlatformAccount(creator) || !samePlatformNamespace(creator, target.account) ||
            [...adapters.values()].some(item => samePlatformNamespace(item.account, creator) && [item.account.id, item.botUserId].includes(creator.id))) return 'denied'
        if (!adapter.readConversationMember || !adapter.readMessage && source.kind === 'message') return 'unavailable'
        const member = await readGroupMember(target, creator.id, signal, current)
        if (!current()) return 'denied'
        if (!member) return 'unavailable'
        if (source.kind === 'migration') {
          if (!options.verifyDeferredMigration) return 'denied'
          const { botId, scene } = personMemoryAddress(target), excerpt = '[延期迁移授权]'
          const redactions = await personMemory.getRedactions({ identity: { botId, personaId: agentPersonaScopeId(binding.agentId) }, subjectId: creator.id })
          if (!current() || isPersonMemoryRedacted({ scene, messageId: source.id, authorId: creator.id, at: source.at, excerpt }, excerpt, redactions)) return 'denied'
          const result = await options.verifyDeferredMigration(request, { signal, isCurrent: current })
          return current() ? result : 'denied'
        }
        if (!isMessageId(source.messageId) || !current()) return 'denied'
        if (await inbox.isRecalled(target, source.messageId) || !current()) return 'denied'
        const fresh = await adapter.readMessage!(target, source.messageId, { isCurrent: current })
        if (!current()) return 'denied'
        if (!fresh) return 'unavailable'
        if (fresh.messageId !== source.messageId || !isConversationAddress(fresh.conversation) ||
            conversationAddressKey(fresh.conversation) !== conversationAddressKey(target) || !isPlatformAccount(fresh.sender) ||
            platformAccountKey(fresh.sender) !== platformAccountKey(creator) || fresh.occurredAt !== source.at ||
            !Number.isSafeInteger(source.at) || source.at <= 0 || source.at > (options.now?.() ?? Date.now()) ||
            phase === 'create' && fresh.text !== request.requestText || matchPersonMemoryCommand(fresh.text) || !allowsFileNames(fresh) ||
            options.allowsText?.(fresh.text, 'incoming') === false || options.allowsToolInput?.(fresh.text) === false) return 'denied'
        const { botId, scene } = personMemoryAddress(target), excerpt = fresh.text || '[延期提醒来源]'
        const redactions = await personMemory.getRedactions({ identity: { botId, personaId: agentPersonaScopeId(binding.agentId) }, subjectId: creator.id })
        if (!current() || isPersonMemoryRedacted({ scene, messageId: source.messageId, authorId: creator.id, at: source.at, excerpt }, excerpt, redactions)) return 'denied'
        return await inbox.isRecalled(target, source.messageId) || !current() ? 'denied' : 'allowed'
      } catch { return current() ? 'unavailable' : 'denied' }
    },
    ...(options.now ? { now: options.now } : {}),
  })
  const deferredActions = createAgentDeferredActionRuntime({
    redis: storage, logger: toolLogger, executor: deferredExecutor, authorization: deferredAuthorization,
    resolveBinding: target => bindingFor(target)?.binding, mode: deferredMode,
    ready: account => isRunning() && adapters.get(platformAccountKey(account))?.isReady() === true,
    capture: binding => captureMemoryTurn(binding), sendReminder: createAgentDeferredReminderSender(messageActions),
    ...(options.now ? { now: options.now } : {}),
  })
  const deferredReminderTool = createAgentDeferredActionTool({ runtime: deferredActions, sourceAt: context => context.request?.occurredAt ?? 0 })
  const registeredTools = createAgentTools({
    get builtIn() { return [...memberTools, ...historyTools, ...(interactionsCurrent() ? interactionTools : []), ...qqActions.builtIn,
      ...(options.deferredActions?.enabled === true && deferredHostCurrent() ? [deferredReminderTool] : []), ...(options.toolRegistry?.builtIn ?? [])] },
    get custom() { return options.toolRegistry?.custom ?? [] },
  }, {
    signal: toolCancellation.signal, diagnostics, checkCurrent: checkToolCurrent,
    ...(options.allowsToolInput ? { allowsInput: options.allowsToolInput } : {}),
    onStart(event, cancel) {
      const target = (event as AgentBindingTurn)._agentBinding!.target
      const key = conversationAddressKey(target)
      const callbacks = pendingTools.get(key) ?? new Set<() => void>()
      callbacks.add(cancel)
      pendingTools.set(key, callbacks)
      return () => { callbacks.delete(cancel); if (!callbacks.size) pendingTools.delete(key) }
    },
    context(event, name, origin) {
      const incoming = event as AgentBindingTurn & {
        simulationActor?: { kind?: string; userId?: string }
        _ensureAgentToolCurrent?: () => Promise<void>
        _sendAgentToolImage?: (image: MessageImage, isCurrent?: () => boolean) => Promise<DeliveryReceipt>
        _sendAgentToolFile?: (file: AgentFileUpload, isCurrent?: () => boolean, signal?: AbortSignal) => Promise<FileDeliveryReceipt>
        _sendAgentToolMedia?: (media: SendMediaAction['media'], isCurrent?: () => boolean, signal?: AbortSignal) => Promise<DeliveryReceipt>
        _sendAgentToolMusic?: (music: AgentMusicCard, isCurrent?: () => boolean, signal?: AbortSignal) => Promise<DeliveryReceipt>
        _sendAgentToolVideoCard?: (card: AgentVideoCard, isCurrent?: () => boolean, signal?: AbortSignal, ensureCurrent?: () => Promise<void>) => Promise<DeliveryReceipt>
        _sendAgentToolMediaRelay?: (plan: AgentMediaRelayPlan, isCurrent?: () => boolean, signal?: AbortSignal, ensureCurrent?: () => Promise<void>) => Promise<DeliveryReceipt>
        _interactAgentTool?: (plan: AgentInteractionPlan, isCurrent: () => boolean, signal: AbortSignal, ensureCurrent?: () => Promise<void>) => Promise<AgentInteractionResult>
        _agentToolPersona?: AgentToolContext['persona']
        _runAgentQqAction?: AgentQqActionRunner
        _qzoneAffinity?: (userId: string) => number
        _qzoneCandidates?: () => Promise<readonly string[]>
        _reviewAgentQqText?: (text: string) => Promise<boolean>
        _sendAgentToolBundle?: (items: readonly MessageBundleItem[], isCurrent?: () => boolean) => Promise<DeliveryReceipt>
        _readAgentToolImages?: (sourceSeq: number, isCurrent?: () => boolean, signal?: AbortSignal) => Promise<readonly { readonly mime: string; readonly base64: string }[]>
        _sendAgentToolMessage?: (message: AgentToolMessage, isCurrent?: () => boolean) => Promise<DeliveryReceipt>
        _agentToolRequest?: AgentToolRequest
        _readAgentFile?: (input: AgentFileRequest, guard: () => boolean, signal: AbortSignal) => Promise<AgentFileBytes>
        _readAgentVideo?: (guard: () => boolean, signal: AbortSignal) => Promise<AgentVideoInput>
        _listAgentFiles?: (input: { readonly query?: string; readonly folderPath?: string }, guard: () => boolean, signal: AbortSignal) => Promise<AgentFileListing>
        _readAgentHistory?: (input: Record<string, unknown>, guard: () => boolean, signal: AbortSignal) => Promise<string>
      }
      const binding = incoming?._agentBinding
      const actor = incoming?.simulationActor
      if (!binding || !isConversationAddress(binding.target) || typeof incoming._isAgentBindingCurrent !== 'function' || typeof incoming._ensureAgentToolCurrent !== 'function' ||
          !actor || !['user', 'autonomous', 'commitment'].includes(String(actor.kind)) ||
          (actor.kind === 'user' && !isPlatformIdentifier(actor.userId))) return undefined
      const target = binding.target
      const expected = agentBindingToken(binding)
      const isCurrent = () => checkToolCurrent(() => {
        try {
          if (!isRunning() || !allowsConversationAI(target) || adapterFor(target)?.isReady() !== true || !conversationEnabled(target) ||
              textInboxFor(target) || incoming._isAgentBindingCurrent?.() !== true || !bindingIsCurrent(target, expected)) return false
          const section = options.getSection()
          if (actor.kind !== 'user' && (origin !== 'builtin' || !isAutonomousExtraToolAllowed(name, section.autonomousTools))) return false
          return resolveSimToolSurface({ policy: normalizeSimToolPolicy(section.toolPolicy), builtInNames: origin === 'builtin' ? [name] : [],
            extraTools: Array.isArray(section.extraTools) ? section.extraTools : [], groupId: target.id }).includes(name)
        }
        catch { return false }
      })
      if (!isCurrent()) return undefined
      return {
        binding: Object.freeze({ ...binding, target: Object.freeze({ ...target, account: Object.freeze({ ...target.account }) }) }),
        actor: Object.freeze({ kind: actor.kind as 'user' | 'autonomous' | 'commitment',
          ...(actor.kind === 'user' ? { user: Object.freeze({ ...target.account, id: actor.userId! }) } : {}),
        }), isCurrent,
        botUserId: adapterFor(target)!.botUserId,
        ...(actor.kind === 'user' && typeof incoming._runAgentQqAction === 'function' ? { runQqAction: incoming._runAgentQqAction } : {}),
        ...(actor.kind === 'user' && incoming._qzoneAffinity ? { qzoneAffinity: incoming._qzoneAffinity } : {}),
        ...(actor.kind === 'user' && incoming._qzoneCandidates ? { qzoneCandidates: incoming._qzoneCandidates } : {}),
        ...(actor.kind === 'user' && incoming._reviewAgentQqText ? { reviewQqText: incoming._reviewAgentQqText } : {}),
        ...(incoming._agentToolPersona ? { persona: incoming._agentToolPersona } : {}),
        ...(actor.kind === 'user' && incoming._agentToolRequest ? { request: Object.freeze({ ...incoming._agentToolRequest,
          mentions: Object.freeze(incoming._agentToolRequest.mentions.map(user => Object.freeze({ ...user }))),
          ...(incoming._agentToolRequest.replyAuthor ? { replyAuthor: Object.freeze({ ...incoming._agentToolRequest.replyAuthor }) } : {}),
        }) } : {}),
        async ensureCurrent() {
          if (!isCurrent()) throw new Error('工具所属回合已失效')
          await incoming._ensureAgentToolCurrent!()
          if (!isCurrent()) throw new Error('工具所属回合已失效')
        },
        ...(typeof incoming._sendAgentToolImage === 'function' ? {
          sendImage: (image: MessageImage, toolCurrent?: () => boolean) =>
            incoming._sendAgentToolImage!(image, () => isCurrent() && toolCurrent?.() !== false),
        } : {}),
        ...(typeof incoming._sendAgentToolFile === 'function' && adapterFor(target)?.actions.sendFile ? {
          sendFile: (file: AgentFileUpload, toolCurrent: () => boolean, signal: AbortSignal) =>
            incoming._sendAgentToolFile!(file, () => isCurrent() && toolCurrent(), signal),
        } : {}),
        ...(typeof incoming._sendAgentToolMusic === 'function' && target.kind === 'group' && adapterFor(target)?.actions.sendMusic ? {
          sendMusic: (music: AgentMusicCard, toolCurrent: () => boolean, signal: AbortSignal) =>
            incoming._sendAgentToolMusic!(music, () => isCurrent() && toolCurrent(), signal),
        } : {}),
        ...(actor.kind === 'user' && target.kind === 'group' && typeof incoming._sendAgentToolMediaRelay === 'function' && adapterFor(target)?.actions.sendMediaRelay ? {
          sendMediaRelay: (plan: AgentMediaRelayPlan, toolCurrent: () => boolean, signal: AbortSignal, ensureCurrent?: () => Promise<void>) =>
            incoming._sendAgentToolMediaRelay!(plan, () => isCurrent() && toolCurrent(), signal, ensureCurrent),
        } : {}),
        ...(actor.kind === 'user' && target.kind === 'group' && interactionsCurrent() && typeof incoming._interactAgentTool === 'function' && adapterFor(target)?.actions.interact ? {
          interact: (plan: AgentInteractionPlan, toolCurrent: () => boolean, signal: AbortSignal, ensureCurrent?: () => Promise<void>) =>
            incoming._interactAgentTool!(plan, () => isCurrent() && interactionsCurrent() && toolCurrent(), signal, ensureCurrent),
        } : {}),
        ...(actor.kind === 'user' && target.kind === 'group' && typeof incoming._sendAgentToolVideoCard === 'function' && adapterFor(target)?.actions.sendVideoCard ? {
          sendVideoCard: (card: AgentVideoCard, toolCurrent: () => boolean, signal: AbortSignal, ensureCurrent?: () => Promise<void>) =>
            incoming._sendAgentToolVideoCard!(card, () => isCurrent() && toolCurrent(), signal, ensureCurrent),
        } : {}),
        ...(actor.kind === 'user' && target.kind === 'group' && adapterFor(target)?.readMessage ? {
          async isSourceAvailable(source: { readonly messageId: string; readonly author: PlatformUserRef }, toolCurrent: () => boolean, signal: AbortSignal): Promise<boolean> {
            const adapter = adapterFor(target), current = () => observeCurrent(() => !signal.aborted && isCurrent() && toolCurrent() && adapterFor(target) === adapter)
            try {
              if (!isMessageId(source.messageId) || !isPlatformAccount(source.author) || !samePlatformNamespace(source.author, target.account) || !adapter?.readMessage || !current()) return false
              const messageId = source.messageId, author = { ...source.author }
              await incoming._ensureAgentToolCurrent!()
              if (!current() || !await inbox.canReply(target, messageId) || await inbox.isRecalled(target, messageId) || !current()) return false
              const message = await adapter.readMessage(target, messageId, { isCurrent: current })
              if (!message || !isConversationAddress(message.conversation) || conversationAddressKey(message.conversation) !== conversationAddressKey(target) ||
                  message.messageId !== messageId || !isPlatformAccount(message.sender) || platformAccountKey(message.sender) !== platformAccountKey(author) ||
                  !Number.isSafeInteger(message.occurredAt) || message.occurredAt <= 0 || matchPersonMemoryCommand(message.text) ||
                  options.allowsText?.(message.text, 'incoming') === false || !allowsFileNames(message) || !current()) return false
              await incoming._ensureAgentToolCurrent!()
              if (!current() || !await inbox.canReply(target, messageId) || await inbox.isRecalled(target, messageId) || !current()) return false
              const { botId, scene } = personMemoryAddress(target), excerpt = message.text || '[工具请求]'
              const redactions = await personMemory.getRedactions({ identity: { botId, personaId: agentPersonaScopeId(binding.agentId) }, subjectId: author.id })
              return !isPersonMemoryRedacted({ scene, messageId, authorId: author.id, at: message.occurredAt, excerpt }, excerpt, redactions) &&
                options.allowsText?.(message.text, 'incoming') !== false && allowsFileNames(message) && current()
            } catch { return false }
          },
        } : {}),
        ...(typeof incoming._sendAgentToolMedia === 'function' && adapterFor(target)?.actions.sendMedia ? {
          sendAudio: (audio: AgentAudioBytes, toolCurrent: () => boolean, signal: AbortSignal) =>
            incoming._sendAgentToolMedia!({ ...audio, kind: 'audio' }, () => isCurrent() && toolCurrent(), signal),
          sendVideo: (video: AgentVideoBytes, toolCurrent: () => boolean, signal: AbortSignal) =>
            incoming._sendAgentToolMedia!({ ...video, kind: 'video' }, () => isCurrent() && toolCurrent(), signal),
        } : {}),
        ...(typeof incoming._sendAgentToolBundle === 'function' && adapterFor(target)?.actions.sendBundle ? {
          sendBundle: (items: readonly MessageBundleItem[], toolCurrent?: () => boolean) =>
            incoming._sendAgentToolBundle!(items, () => isCurrent() && toolCurrent?.() !== false),
        } : {}),
        ...(typeof incoming._readAgentToolImages === 'function' ? {
          readImages: (sourceSeq: number, toolCurrent?: () => boolean, signal?: AbortSignal) =>
            incoming._readAgentToolImages!(sourceSeq, () => isCurrent() && toolCurrent?.() !== false, signal),
        } : {}),
        ...(actor.kind === 'user' && typeof incoming._readAgentHistory === 'function' ? {
          readHistory: (input: Record<string, unknown>, guard: () => boolean, signal: AbortSignal) => incoming._readAgentHistory!(input, () => isCurrent() && guard(), signal),
        } : {}),
        ...(actor.kind === 'user' && target.kind === 'group' && typeof incoming._readAgentFile === 'function' ? {
          readFile: (input: AgentFileRequest, guard: () => boolean, signal: AbortSignal) => incoming._readAgentFile!(input, () => isCurrent() && guard(), signal),
        } : {}),
        ...(actor.kind === 'user' && target.kind === 'group' && typeof incoming._readAgentVideo === 'function' ? {
          readVideo: (guard: () => boolean, signal: AbortSignal) => incoming._readAgentVideo!(() => isCurrent() && guard(), signal),
        } : {}),
        ...(actor.kind === 'user' && target.kind === 'group' && typeof incoming._listAgentFiles === 'function' ? {
          listFiles: (input: { readonly query?: string; readonly folderPath?: string }, guard: () => boolean, signal: AbortSignal) => incoming._listAgentFiles!(input, () => isCurrent() && guard(), signal),
        } : {}),
        ...(actor.kind === 'user' && target.kind === 'group' ? {
          ...(adapterFor(target)?.readConversationMember ? {
            readMember: (userId: string, guard: () => boolean, signal: AbortSignal) => readGroupMember(target, userId, signal, () => isCurrent() && guard()),
          } : {}),
          ...(adapterFor(target)?.listConversationMembers ? {
            listMembers: (guard: () => boolean, signal: AbortSignal) => readGroupMembers(target, signal, () => isCurrent() && guard()),
          } : {}),
          ...(typeof incoming._sendAgentToolMessage === 'function' ? {
            async sendMessage(message: AgentToolMessage, guard: () => boolean, signal: AbortSignal): Promise<DeliveryReceipt> {
              const current = () => !signal.aborted && isCurrent() && guard()
              for (const id of message.mentionUserIds ?? []) {
                await incoming._ensureAgentToolCurrent!()
                if (!await readGroupMember(target, id, signal, current)) return { state: 'failed', code: 'member_unverified' }
              }
              await incoming._ensureAgentToolCurrent!()
              if (!current()) return { state: 'failed', code: 'binding_changed' }
              return incoming._sendAgentToolMessage!(message, current)
            },
          } : {}),
        } : {}),
        recordUsage(model, usage) {
          options.recordTokens?.({ scope: simulationAddressKey(target), stage: 'agent-tool', model, usage })
        },
      }
    },
  })
  const runtime = createSimulationRuntime({
    supportsQqAction,
    executeQzone: qqActions.executeQzone,
    ...options,
    ...(options.observeExecutionCurrent ? { observeCurrent } : {}),
    logger, diagnostics,
    withDiagnosticScope: (scope, operation, fn) => diagnostics.run(scope, operation, fn),
    ...(options.failureNoticeFallback ? { failureNoticeFallback: options.failureNoticeFallback } : {}),
    redis: storage,
    durableIngress: true,
    ...registeredTools,
    extraToolsPlatformNeutral: true,
    messageActions,
    ...(options.interactions?.enabled === true ? { performInteractions,
      supportsMessageRecall: (target: ConversationAddress) => interactionsCurrent() && target.kind === 'group' &&
        !!adapterFor(target)?.actions.interact && !!adapterFor(target)?.readOwnMessage,
      supportsGroupManagement: (target: ConversationAddress) => interactionsCurrent() && target.kind === 'group' &&
        !!adapterFor(target)?.actions.interact && !!adapterFor(target)?.readConversationMember && !!adapterFor(target)?.listConversationMembers,
      supportsInteractions: (target: ConversationAddress) => interactionsCurrent() && target.kind === 'group' &&
        adapterFor(target)?.isReady() === true && !!adapterFor(target)?.actions.interact,
    } : {}),
    ...(options.adapters.some(adapter => adapter.listConversationMembers) ? { readGroupMembers } : {}),
    handlesTarget: target => target.kind !== 'private' && !!adapterFor(target),
    allowsSimulation: target => !options.useTextGroup?.(target),
    allowsConversationAI,
    ...(options.videoSearchProvider ? { resolveVideoCard: async (input: { readonly query?: string; readonly url?: string }, target: ConversationAddress,
      context: import('../contracts/agentMediaRelay.js').AgentMediaResourceContext) => {
      const binding = bindingFor(target)?.binding
      if (!binding) throw new Error('视频查询会话不可用')
      const token = agentBindingToken(binding), permission = activity.capture(target)
      const current = () => observeCurrent(() => isRunning() && allowsConversationAI(target) && permission.isCurrent() && !context.signal.aborted &&
        context.isCurrent() && options.isVideoSearchCurrent?.() !== false && bindingIsCurrent(target, token))
      const ensure = async () => { if (!current()) throw new Error('视频查询权限已改变'); await context.ensureCurrent?.(); if (!current()) throw new Error('视频查询权限已改变') }
      try {
        await ensure()
        const card = await options.videoSearchProvider!.resolve(input, { signal: AbortSignal.any([context.signal, permission.signal]), isCurrent: current, ensureCurrent: ensure })
        await ensure()
        return validateAgentVideoCard(card, text => options.allowsText?.(text, 'outgoing') !== false)
      } finally { permission.release() }
    } } : {}),
    beginMemoryTurn,
    ...(options.cognition?.enabled === true ? {
      async readCognition(target: ConversationAddress, query: string, guard: CognitionGuard) {
        const selected = bindingFor(target)
        return selected ? cognition.recall({ agentId: selected.binding.agentId, conversation: target, text: query, excludeKinds: ['goal'] }, guard) : undefined
      },
      projectCognition: (input: import('../contracts/agentCognition.js').CognitionTurnProjection, guard: CognitionGuard) => cognition.projectTurn(input, guard),
      consolidateCognition: (binding: AgentBindingSnapshot, guard: CognitionGuard, model: import('../contracts/agentCognition.js').CognitionConsolidator) => cognition.consolidate(binding.agentId, binding.target, guard, model),
    } : {}),
    isMemoryInputAvailable: account => !privacyBlocked(platformAccountKey(account)),
    isAccountReady: account => isRunning() && adapters.get(platformAccountKey(account))?.isReady() === true,
    async readSemanticMemory(target, query, guard, signal, excludeMessageIds) {
      const selected = bindingFor(target)
      return selected ? semanticMemory.read(selected.binding, query, guard, signal, excludeMessageIds) : undefined
    },
    ...(options.history?.enabled === true ? { async readHistory(target: ConversationAddress, input: Record<string, unknown>, source: AgentHistoryRequestSource, guard: () => boolean, signal?: AbortSignal) {
      const selected = bindingFor(target)
      if (!selected) throw new Error('历史查询的角色绑定不可用')
      return history.read(selected.binding, input, source, guard, signal)
    } } : {}),
    ...(options.history?.enabled === true ? { async readUserStyleSources(target: ConversationAddress, days: number, guard: () => boolean, signal: AbortSignal) {
      const selected = bindingFor(target)
      if (!selected || target.kind !== 'group') throw new Error('口头禅来源会话不可用')
      return history.readStyleSources(selected.binding, days, guard, signal)
    } } : {}),
    getStyleBotUserIds: () => [...adapters.values()].map(adapter => adapter.botUserId).filter((id): id is string => typeof id === 'string' && !!id),
    getSelf: (_id, account) => {
      const adapter = account && adapters.get(platformAccountKey(account))
      return adapter ? { id: adapter.account.id, name: adapter.botName, userId: adapter.botUserId } : { id: '', name: '' }
    },
    getPersona: (_id, _self, target) => {
      const persona = target && bindingFor(target)
      if (!persona) throw new Error('独立宿主会话没有有效角色绑定')
      return persona
    },
    loadDelegatedMemories: scope => typeof scope === 'string' ? [] : memories.store.load(scope),
    getBoundTools: target => adapterFor(target) && target.kind === 'group' ? [new commitments.CommitmentTool(), new memories.DelegateMemoryTool(),
      ...(options.groupMemory?.enabled === true ? [groupKnowledge] : [])] : [],
    async readQuotedMessage(target, messageId, guard) {
      const adapter = adapterFor(target)
      const isCurrent = () => checkToolCurrent(() => isRunning() && adapter?.isReady() === true && conversationEnabled(target) &&
        !textInboxFor(target) && guard.isCurrent?.() !== false)
      if (!isMessageId(messageId) || !adapter?.readMessage || !isCurrent() || await inbox.isRecalled(target, messageId) || !isCurrent()) return undefined
      const source = await adapter.readMessage(target, messageId, { isCurrent })
      if (!source || source.messageId !== messageId || conversationAddressKey(source.conversation) !== conversationAddressKey(target) ||
          matchPersonMemoryCommand(source.text) || await inbox.isRecalled(target, messageId) || !isCurrent() ||
          options.allowsText?.(source.text, 'incoming') === false || !allowsFileNames(source)) return undefined
      return mediaSafeMessage(source)
    },
    async readConversationMemory(target, viewer, guard) {
      const selected = bindingFor(target)
      if (!selected || guard?.() === false) return { digest: '', episodes: '' }
      return conversationMemory.read(selected.binding, viewer, () => guard?.() !== false && isRunning(), { simulation: true })
    },
    async readGroupMemory(target, _viewer, sourceId, guard) {
      const selected = bindingFor(target)
      if (!selected || !guard()) return ''
      return groupMemory.prepare(selected.binding, sourceId, guard)
    },
    async isGroupMemoryCurrent(target, expected, includeWorkflows, guard) {
      const selected = bindingFor(target)
      return !!selected && guard() && await groupMemory.read(selected.binding, guard, includeWorkflows) === expected && guard()
    },
    async recordGroupReply(target, guard) {
      const selected = bindingFor(target)
      if (selected) try { await groupMemory.confirmed(selected.binding, guard) } catch (error) { diagnostics.emit({ stage: 'memory', operation: 'group_learning_confirm', outcome: 'failed', code: 'confirmed_reply_record_failed', error }) }
    },
    async recordEpisode(input) {
      const binding = input.binding
      if (!binding || !input.source || !input.replyIds?.length || !input.isCurrent?.()) return
      await conversationMemory.recordEpisode({ binding, source: input.source, at: input.at ?? (options.now?.() ?? Date.now()),
        ...(input.userId ? { userId: input.userId } : {}), ...(input.userName ? { userName: input.userName } : {}),
        summary: input.summary, reply: input.reply, messageIds: input.messageIds ?? [], replyIds: input.replyIds,
      }, input.isCurrent)
    },
    supportsForwardRead: target => !!adapterFor(target)?.readForward,
    async readForward(target, source, guard) {
      const adapter = adapterFor(target)
      const isCurrent = () => isRunning() && adapter?.isReady() === true && conversationEnabled(target) &&
        !textInboxFor(target) && guard.isCurrent?.() !== false
      if (!adapter?.readForward || !isCurrent() || !await inbox.canReply(target, source.messageId) || !isCurrent()) return undefined
      const content = await adapter.readForward(target, source, { isCurrent })
      if (!content || !await inbox.canReply(target, source.messageId) || !isCurrent()) return undefined
      const entries = content.entries.filter(entry => !matchPersonMemoryCommand(entry.text) &&
        options.allowsText?.(`${entry.senderName || ''}\n${entry.text}`, 'incoming') !== false)
      return { entries: entries.map(entry => ({ ...entry, text: sanitizeAgentXiaohongshuShareText(entry.text),
        ...(entry.senderName === undefined ? {} : { senderName: sanitizeAgentXiaohongshuShareText(entry.senderName) }) })), partial: content.partial || entries.length !== content.entries.length }
    },
    supportsMessageImages: target => (!!options.describeImages || !!options.collectMessageSticker) && !!adapterFor(target)?.readMessageImages,
    async readMessageImages(target, source, guard) {
      const adapter = adapterFor(target)
      if (!adapter?.readMessageImages || target.kind === 'private') return undefined
      const originalId = source.quotedMessageId ?? source.messageId
      const isCurrent = () => observeCurrent(() => isRunning() && !guard.signal?.aborted && adapter.isReady() && conversationEnabled(target) &&
        !textInboxFor(target) && guard.isCurrent?.() !== false)
      const canRead = async () => isCurrent() && await inbox.canReply(target, source.messageId) &&
        !(source.quotedMessageId && await inbox.isRecalled(target, source.quotedMessageId)) && isCurrent()
      if (!await canRead()) return undefined
      const images = await adapter.readMessageImages(target, originalId, {
        isCurrent,
        ...(guard.signal ? { signal: guard.signal } : {}),
        async allowsSource(original) {
          return original.messageId === originalId && conversationAddressKey(original.conversation) === conversationAddressKey(target) &&
            options.allowsText?.(original.text, 'incoming') !== false && allowsFileNames(original) && await guard.allowsSource(original) && await canRead()
        },
      })
      return images && await canRead() ? images : undefined
    },
    async readMessageFile(target, source, fileIndex, guard) {
      const adapter = adapterFor(target)
      if (!adapter?.readMessageFile || target.kind !== 'group') return undefined
      const originalId = source.quotedMessageId ?? source.messageId
      const isCurrent = () => !guard.signal.aborted && isRunning() && adapterFor(target) === adapter && adapter.isReady() && conversationEnabled(target) && !textInboxFor(target) && guard.isCurrent()
      const canRead = async () => isCurrent() && await inbox.canReply(target, source.messageId) &&
        !(source.quotedMessageId && await inbox.isRecalled(target, source.quotedMessageId)) && isCurrent()
      const ensureCurrent = async () => { await guard.ensureCurrent?.(); if (!await canRead()) throw new Error('文件来源已失效') }
      if (!await canRead()) return undefined
      const result = await adapter.readMessageFile(target, originalId, fileIndex, {
        signal: guard.signal, isCurrent, ensureCurrent,
        async allowsSource(original) {
          return original.messageId === originalId && conversationAddressKey(original.conversation) === conversationAddressKey(target) &&
            options.allowsText?.(original.text, 'incoming') !== false && allowsFileNames(original) && await guard.allowsSource(original) && await canRead()
        },
      })
      await ensureCurrent()
      return result ? validateAgentFileBytes(result) : undefined
    },
    async readMessageVideo(target, messageId, guard) {
      const adapter = adapterFor(target)
      if (!adapter?.readMessageVideo || target.kind !== 'group') return undefined
      const isCurrent = () => checkToolCurrent(() => !guard.signal.aborted && isRunning() && adapterFor(target) === adapter && adapter.isReady() &&
        conversationEnabled(target) && !textInboxFor(target) && guard.isCurrent())
      const canRead = async () => isCurrent() && await inbox.canReply(target, messageId) && isCurrent()
      const ensureCurrent = async () => { await guard.ensureCurrent?.(); if (!await canRead()) throw new Error('视频来源已失效') }
      if (!await canRead()) return undefined
      const result = await adapter.readMessageVideo(target, messageId, {
        signal: guard.signal, isCurrent, ensureCurrent, ...(guard.inspectOnly ? { inspectOnly: true } : {}),
        async allowsSource(original) {
          return conversationAddressKey(original.conversation) === conversationAddressKey(target) && !!original.messageId &&
            !matchPersonMemoryCommand(original.text) && !await inbox.isRecalled(target, original.messageId) && options.allowsText?.(original.text, 'incoming') !== false &&
            allowsFileNames(original) && await guard.allowsSource(original) && await canRead()
        },
        async allowsForwardSource(source) {
          return samePlatformNamespace(source.author, target.account) && Number.isSafeInteger(source.occurredAt) && source.occurredAt > 0 &&
            await guard.allowsForwardSource(source) && await canRead()
        },
      })
      await ensureCurrent()
      return result
    },
    async listConversationFiles(target, guard) {
      const adapter = adapterFor(target)
      if (!adapter?.listConversationFiles || target.kind !== 'group') return undefined
      const isCurrent = () => !guard.signal.aborted && isRunning() && adapterFor(target) === adapter && adapter.isReady() && conversationEnabled(target) && !textInboxFor(target) && guard.isCurrent()
      const ensureCurrent = async () => { await guard.ensureCurrent?.(); if (!isCurrent()) throw new Error('文件目录权限已失效') }
      await ensureCurrent()
      const result = await adapter.listConversationFiles(target, { signal: guard.signal, isCurrent, ensureCurrent })
      await ensureCurrent()
      if (!result || conversationAddressKey(result.target) !== conversationAddressKey(target) || result.files.some(file => file.uploadedBy && !samePlatformNamespace(file.uploadedBy, target.account))) return undefined
      if (result.files.some(file => options.allowsText?.(`${file.name}\n${file.folderPath}`, 'incoming') === false)) return undefined
      return result
    },
    async readConversationFile(target, entry, guard) {
      const adapter = adapterFor(target)
      if (!adapter?.readConversationFile || target.kind !== 'group') return undefined
      const isCurrent = () => !guard.signal.aborted && isRunning() && adapterFor(target) === adapter && adapter.isReady() && conversationEnabled(target) && !textInboxFor(target) && guard.isCurrent()
      const ensureCurrent = async () => { await guard.ensureCurrent?.(); if (!isCurrent()) throw new Error('群文件权限已失效') }
      await ensureCurrent()
      const result = await adapter.readConversationFile(target, entry, {
        signal: guard.signal, isCurrent, ensureCurrent,
        async allowsFile(current) {
          await ensureCurrent()
          return options.allowsText?.(`${current.name}\n${current.folderPath}`, 'incoming') !== false &&
            (!current.uploadedBy || samePlatformNamespace(current.uploadedBy, target.account)) && await guard.allowsFile(current) && isCurrent()
        },
      })
      await ensureCurrent()
      return result ? validateAgentFileBytes(result) : undefined
    },
    readPublicFile: (url, guard) => readAgentPublicFile(url, guard),
    isMessageRecalled: (target, messageId) => inbox.isRecalled(target, messageId),
  })
  const commitments = createCommitmentRuntime({
    redis: storage, logger: toolLogger, getBot: () => null,
    messageActions,
    handlesTarget: target => isRunning() && !!target && adapterFor(target)?.isReady() === true && conversationEnabled(target),
    resolveBinding: target => bindingFor(target)?.binding,
    resolvePrivatePeer: privatePeerFor,
    allowsExecution: allowsConversationAI,
    captureExecution: target => activity.capture(target),
    isSimulationGroup: (_id, target) => target ? runtime.isConversationActive(target) : false,
    waitForSimulation: true,
    wakeSim: (id, card, runOptions, target) => runtime.wakeForCommitment(id, card, runOptions, target),
    loadConfig: () => ({}),
    ...(options.now ? { now: options.now } : {}),
  })
  const management: AgentManagementModules | undefined = options.managementBindings && (() => {
    const bindings = options.managementBindings!
    const profiles = createAgentProfileManagement({ redis: storage, bindings, ...(options.now ? { now: options.now } : {}) })
    // Reuse the runtime's exact store: cancellation must reach its in-flight invalidation listeners.
    const trusteeship = createAgentTrusteeshipManagement({ store: commitments.store, redis: storage, bindings,
      ...(options.now ? { now: options.now } : {}) })
    function authority(context: AgentManagementContext): AgentManagementContext {
      const signal = AbortSignal.any([context.signal, toolCancellation.signal, ...(options.signal ? [options.signal] : [])])
      const invalid = (): never => { throw new AgentManagementError('conflict') }
      const parentCheck = captureSynchronousGuardCheck(context, invalid)
      const current = () => { try { return !signal.aborted && isRunning() && context.isCurrent() } catch { return false } }
      const authority = parentCheck ? createSynchronousGuard(signal, () => {
        parentCheck()
        // Runtime hooks may synchronously revoke the parent request without aborting it.
        // Keep its fresh observation after that callback as well as the preflight above.
        try { if (!isRunning()) invalid(); parentCheck() } catch { invalid() }
      }, invalid) : { signal, isCurrent: current,
        ensureCurrent() { context.ensureCurrent(); if (!current()) invalid() } }
      const { ensureCurrent } = authority
      return { ...authority, ...(context.binding ? { binding: context.binding } : {}),
        ...(context.profileForget ? { profileForget: context.profileForget } : {}),
        async authorize(operation, binding, guard) {
          const ownerCheck = captureSynchronousGuardCheck(authority, invalid), selectedCheck = captureSynchronousGuardCheck(guard, invalid)
          const selected = ownerCheck && selectedCheck ? createSynchronousGuard(signal, () => {
            ownerCheck(); selectedCheck()
          }, invalid) : { signal, isCurrent: () => authority.isCurrent() && guard.isCurrent(),
            ensureCurrent() { ensureCurrent(); guard.ensureCurrent() } }
          selected.ensureCurrent()
          const result = await context.authorize(operation, binding, selected)
          selected.ensureCurrent()
          return result
        },
      }
    }
    async function invoke<T>(context: AgentManagementContext, action: (guard: AgentManagementContext) => Promise<T>) {
      const guard = authority(context)
      guard.ensureCurrent()
      const result = await action(guard)
      guard.ensureCurrent()
      return result
    }
    async function changeProfile<T>(context: AgentManagementContext, userId: string, operation: 'profiles.delete' | 'profiles.delete-field',
      action: (guard: AgentManagementContext) => Promise<T>, cleanupSubjectId?: string) {
      return invoke(context, async guard => {
        const binding = guard.binding
        if (!binding) throw new AgentManagementError('invalid_request')
        const ensureBinding = () => {
          guard.ensureCurrent()
          const live = bindings.resolve(binding.target)
          if (!live || conversationAddressKey(live.target) !== conversationAddressKey(binding.target) ||
              agentBindingToken(live) !== agentBindingToken(binding)) throw new AgentManagementError('conflict')
        }
        ensureBinding()
        const decision = await guard.authorize(operation, binding, { signal: guard.signal,
          isCurrent: () => { try { ensureBinding(); return true } catch { return false } }, ensureCurrent: ensureBinding })
        ensureBinding()
        if (decision !== 'allowed') throw new AgentManagementError(decision === 'denied' ? 'forbidden' : 'unavailable')
        // Invalidate existing source consumers before the first storage await. Future turns wait
        // until the real store has committed its tombstones, then re-read the privacy versions.
        const at = options.now?.() ?? Date.now(), cutoff = guard.profileForget
        if (cutoff && (operation !== 'profiles.delete' || cutoff.userId !== cleanupSubjectId || cutoff.bindingToken !== agentBindingToken(binding) ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(cutoff.operationId) ||
            !Number.isSafeInteger(cutoff.through) || cutoff.through < 0 || cutoff.through > at)) throw new AgentManagementError('invalid_request')
        const through = cutoff?.through ?? at
        const finishAdmission = beginPrivacyAdmission(binding)
        try {
          const result = await action(guard); ensureBinding()
          const invalidateProfileCognition = async () => {
            const before = through
            let sourceIds: string[] | undefined
            if (operation === 'profiles.delete-field') {
              const { botId, scene } = personMemoryAddress(binding.target, privatePeerFor(binding.target))
              const redactions = await personMemory.getRedactions({ identity: { botId, personaId: agentPersonaScopeId(binding.agentId) }, subjectId: userId })
              sourceIds = (await cognitionStore.read(binding.agentId)).sources.filter(source => source.status === 'active' && source.authorId === userId &&
                conversationAddressKey(source.conversation) === conversationAddressKey(binding.target) &&
                isPersonMemoryRedacted({ scene, authorId: userId, messageId: source.nativeId, at: source.occurredAt, excerpt: source.content }, source.content, redactions)).map(source => source.id)
            }
            if (!sourceIds || sourceIds.length) await cognition.invalidate(binding.agentId, {
              id: cutoff ? `profile:${cutoff.operationId}` : `profile:${createHash('sha256').update(JSON.stringify([
                operation, conversationAddressKey(binding.target), userId, before, sourceIds ?? null,
              ])).digest('hex')}`,
              account: binding.target.account, authorId: userId, conversation: binding.target, before,
              ...(sourceIds ? { sourceIds } : {}),
            }, { isCurrent: () => { try { ensureBinding(); return true } catch { return false } }, signal: guard.signal })
          }
          if (cleanupSubjectId !== undefined || result !== false && options.cognition?.enabled === true) {
            const subject = { account: binding.target.account, agentId: binding.agentId, subjectId: cleanupSubjectId ?? userId, target: binding.target, through }
            const cleanupGuard = sourceCleanupGuard(() => {
              try { ensureBinding(); return true } catch { return false }
            }, ensureBinding, guard.signal)
            const results = await Promise.allSettled([
              ...(cleanupSubjectId !== undefined ? [
                ...(options.localEmojiCleanup ? [completeLocalEmojiCleanup(cleanup => options.localEmojiCleanup!.purgeSubject(subject, cleanup), cleanupGuard)] : []),
                completeSemanticMemoryCleanup(subject, cleanupGuard),
                completeConversationMemoryCleanup(subject, cleanupGuard),
                completeSourceMemoryCleanup(subject, cleanupGuard),
                completeGroupMemoryCleanup(subject, cleanupGuard),
              ] : []),
              ...(options.cognition?.enabled === true ? [invalidateProfileCognition()] : []),
            ])
            const rejected = results.find(result => result.status === 'rejected')
            if (rejected?.status === 'rejected') throw rejected.reason
          }
          ensureBinding(); return result
        }
        finally { finishAdmission() }
      })
    }
    return {
      profiles: {
        list: context => invoke(context, guard => profiles.list(guard)),
        remove: (userId, context) => changeProfile(context, userId, 'profiles.delete', guard => profiles.remove(userId, guard), userId),
        removeField: (userId, field, value, context) => changeProfile(context, userId, 'profiles.delete-field', guard => profiles.removeField(userId, field, value, guard)),
      },
      trusteeship: {
        overview: context => invoke(context, async guard => ({ ...await trusteeship.overview(guard) })),
        cancelCommitment: (scopeKey, id, context) => invoke(context, guard => trusteeship.cancelCommitment(scopeKey, id, guard)),
        deleteDelegated: (scopeKey, id, context) => invoke(context, guard => trusteeship.deleteDelegated(scopeKey, id, guard)),
        clearFailLog: context => invoke(context, guard => trusteeship.clearFailLog(guard)),
      },
    } satisfies AgentManagementModules
  })()
  const textPersonMemory = createTextPersonMemory({
    redis: storage, memory: personMemory,
    ...(options.personProfileExtract ? { extract: options.personProfileExtract } : {}),
    config: () => options.memorySystem,
    token: textBindingToken,
    current(batch) {
      const target = batch.binding.target
      const selected = bindingFor(target)
      return isRunning() && conversationEnabled(target) && !!textInboxFor(target) &&
        !!selected && textBindingToken(selected.binding) === batch.token &&
        (target.kind !== 'private' || privatePeerFor(target) === batch.subjectId && batch.peerId === batch.subjectId) &&
        batch.messages.every(row => options.allowsText?.(row.text, 'incoming') !== false)
    },
    available: target => isRunning() && allowsConversationAI(target) && adapterFor(target)?.isReady() === true && !privacyBlocked(platformAccountKey(target.account)),
    begin: beginMemoryTurn,
    isRecalled: inbox.isRecalled,
    logger, diagnostics,
    ...(options.recordTokens ? { recordUsage: options.recordTokens } : {}),
    ...(options.now ? { now: options.now } : {}),
  })
  const conversationMemory = createConversationMemory({
    redis: storage, memory: personMemory,
    midterm: () => options.midtermMemory,
    episodic: () => options.episodicMemory,
    ...(options.summarizeConversation ? { summarize: options.summarizeConversation } : {}),
    resolve(target) {
      if (!isRunning() || !conversationEnabled(target)) return undefined
      const binding = bindingFor(target)?.binding
      return binding && { binding }
    },
    available: target => isRunning() && allowsConversationAI(target) && adapterFor(target)?.isReady() === true && !privacyBlocked(platformAccountKey(target.account)),
    privatePeer: privatePeerFor, isRecalled: inbox.isRecalled, begin: beginMemoryTurn,
    ...(options.observeExecutionCurrent ? { observeCurrent } : {}),
    isRunning, allowsText: text => options.allowsText?.(text, 'incoming') !== false && options.allowsText?.(text, 'outgoing') !== false,
    logger, diagnostics, ...(options.recordTokens ? { recordUsage: options.recordTokens } : {}), ...(options.now ? { now: options.now } : {}),
  })
  const conversationMemoryCleanup: AgentConversationMemoryCleanup = Object.freeze({
    async purgeSubject(input: AgentConversationMemoryPurgeSubject, authority: AgentConversationMemoryCleanupGuard): Promise<AgentConversationMemoryCleanupReceipt> {
      conversationCleanupSelector(input)
      const owned = { ...input, account: { ...input.account },
        ...(input.target ? { target: { ...input.target, account: { ...input.target.account } } } : {}) }
      const guard = sourceCleanupGuard(() => authority.isCurrent(), () => authority.ensureCurrent(), authority.signal)
      await guard.ensureCurrent()
      const key = platformAccountKey(owned.account), targetKey = owned.target && conversationAddressKey(owned.target)
      privacyAdmissions.set(key, (privacyAdmissions.get(key) ?? 0) + 1)
      // A model holding old conversation context cannot label its late episode with the new generation.
      for (const [invalidate, turn] of memoryTurns.get(key) ?? []) if (turn.agentId === owned.agentId && (!targetKey || turn.targetKey === targetKey)) invalidate()
      try {
        const receipt = await conversationMemory.purgeSubject(owned, guard)
        await guard.ensureCurrent()
        return receipt
      } finally {
        const remaining = (privacyAdmissions.get(key) ?? 1) - 1
        if (remaining > 0) privacyAdmissions.set(key, remaining)
        else privacyAdmissions.delete(key)
        wakeMemoryTurns(key)
      }
    },
  })
  async function runSourceCleanup<T>(input: AgentSourceMemoryPurgeSubject, authority: AgentSourceMemoryCleanupGuard,
    action: (selected: AgentSourceMemoryPurgeSubject, guard: AgentSourceMemoryCleanupGuard) => Promise<T>): Promise<T> {
    conversationCleanupSelector(input)
    const owned = structuredClone(input)
    const guard = sourceCleanupGuard(() => authority.isCurrent(), () => authority.ensureCurrent(), authority.signal)
    await guard.ensureCurrent()
    const key = platformAccountKey(owned.account), targetKey = owned.target && conversationAddressKey(owned.target)
    privacyAdmissions.set(key, (privacyAdmissions.get(key) ?? 0) + 1)
    for (const [invalidate, turn] of memoryTurns.get(key) ?? []) if (turn.agentId === owned.agentId && (!targetKey || turn.targetKey === targetKey)) invalidate()
    try { const result = await action(owned, guard); await guard.ensureCurrent(); return result }
    finally {
      const remaining = (privacyAdmissions.get(key) ?? 1) - 1
      if (remaining > 0) privacyAdmissions.set(key, remaining)
      else privacyAdmissions.delete(key)
      wakeMemoryTurns(key)
    }
  }
  const sourceMemoryCleanup: AgentSourceMemoryCleanup = Object.freeze({
    purgeSubject: (input: AgentSourceMemoryPurgeSubject, authority: AgentSourceMemoryCleanupGuard) => runSourceCleanup(input, authority, async (selected, guard) => {
      const results = await Promise.allSettled([
        history.purgeSubject(selected, guard), textPersonMemory.purgeSubject(selected, guard), memories.store.purgeSubject(selected, guard),
        commitments.store.purgeSubject(selected, guard),
      ])
      const rejected = results.find(result => result.status === 'rejected')
      if (rejected?.status === 'rejected') throw rejected.reason
      return { usage: 'blocked' as const, partitions: results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []) }
    }),
  })
  const groupMemoryCleanup: AgentGroupMemoryCleanup = Object.freeze({
    purgeSubject: (input: AgentSourceMemoryPurgeSubject, authority: AgentSourceMemoryCleanupGuard) => runSourceCleanup(input, authority, (selected, guard) => groupMemory.purgeSubject(selected, guard)),
  })
  const authorizePrivateSource: NonNullable<Parameters<typeof createAgentSemanticMemory>[0]['authorizePrivateSource']> = async (viewer, source, subjectId, context) => {
    const adapter = adapterFor(source.target)
    const viewerToken = agentBindingToken(viewer), sourceToken = agentBindingToken(source)
    const isCurrent = () => context.isCurrent() && isRunning() && viewer.target.kind === 'private' && source.target.kind === 'group' &&
      viewer.agentId === source.agentId && platformAccountKey(viewer.target.account) === platformAccountKey(source.target.account) &&
      privatePeerFor(viewer.target) === subjectId && bindingIsCurrent(viewer.target, viewerToken) && bindingIsCurrent(source.target, sourceToken) &&
      adapterFor(source.target) === adapter && adapter?.isReady() === true
    if (!adapter || !isCurrent()) return false
    const snapshot = await readGroupMember(source.target, adapter.botUserId, context.signal, isCurrent)
    return !!snapshot && snapshot.member.user.id === adapter.botUserId && isCurrent()
  }
  const history = createAgentHistory({
    redis: storage, memory: personMemory, config: () => options.history,
    resolve: target => isRunning() && conversationEnabled(target) ? bindingFor(target) : undefined,
    available: target => allowsConversationAI(target) && adapterFor(target)?.isReady() === true && !privacyBlocked(platformAccountKey(target.account)),
    privatePeer: privatePeerFor, isRecalled: inbox.isRecalled, begin: beginMemoryTurn, isRunning, authorizePrivateSource,
    allowsText: text => options.allowsText?.(text, 'incoming') !== false && options.allowsText?.(text, 'outgoing') !== false,
    logger, ...(options.now ? { now: options.now } : {}),
  })
  const semanticMemory = createAgentSemanticMemory({
    redis: storage, memory: personMemory, config: () => options.semanticMemory,
    ...(options.semanticMemoryBackend ? { backend: options.semanticMemoryBackend } : {}),
    resolve: target => isRunning() && conversationEnabled(target) ? bindingFor(target) : undefined,
    available: target => allowsConversationAI(target) && adapterFor(target)?.isReady() === true && !privacyBlocked(platformAccountKey(target.account)),
    privatePeer: privatePeerFor, isRecalled: inbox.isRecalled, begin: beginMemoryTurn, isRunning,
    authorizePrivateSource,
    allowsText: text => options.allowsText?.(text, 'incoming') !== false && options.allowsText?.(text, 'outgoing') !== false,
    logger, ...(options.now ? { now: options.now } : {}),
  })
  const semanticMemoryCleanup: AgentSemanticMemoryCleanup = Object.freeze({
    async purgeSubject(input: AgentSemanticMemoryPurgeSubject, authority: AgentSemanticMemoryCleanupGuard): Promise<AgentSemanticMemoryCleanupReceipt> {
      const guard = sourceCleanupGuard(() => authority.isCurrent(), () => authority.ensureCurrent(), authority.signal)
      await guard.ensureCurrent()
      const receipt = await semanticMemory.purgeSubject(input, guard)
      await guard.ensureCurrent()
      return receipt
    },
  })
  const cognitionCharacters = createCharacterStore({ redis: storage, ...(options.now ? { now: options.now } : {}) })
  const cognitionStore = createCognitionStore(storage)
  const cognition = createAgentCognition({
    redis: storage,
    async canUseNode(node, guard) {
      const reference = cognitionCharacterReference(node)
      if (!reference) return true
      if (!guard.isCurrent() || guard.signal?.aborted) return false
      const binding = bindingFor(node.conversation)?.binding
      if (!binding) return false
      const { botId, scene } = personMemoryAddress(node.conversation)
      const character = await cognitionCharacters.load({ botId, personaId: agentPersonaScopeId(binding.agentId), groupId: scene.id })
      if (reference.kind === 'memory') return activeCharacterMemories(character).some(memory => memory.id === reference.id && memory.content === node.content)
      if (reference.kind === 'goal') return character.goals.some(goal => goal.id === reference.id && JSON.stringify({ title: goal.title, nextStep: goal.nextStep, status: goal.status, outcome: goal.lastOutcome ?? null }) === node.content)
      return character.receipts.some(receipt => receipt.id === reference.id && receipt.status !== 'pending' &&
        JSON.stringify({ toolName: receipt.toolName, status: receipt.status, summary: receipt.summary, goalId: receipt.goalId ?? null }) === node.content)
    },
    async canUseSource(source, guard) {
      const target = source.conversation, selected = bindingFor(target)
      if (options.cognition?.enabled !== true || !isRunning() || !guard.isCurrent() || guard.signal?.aborted || !selected ||
          selected.binding.agentId !== source.agentId || adapterFor(target)?.isReady() !== true ||
          !conversationEnabled(target) || !allowsConversationAI(target) ||
          privacyBlocked(platformAccountKey(target.account))) return false
      const { botId, scene } = personMemoryAddress(target, privatePeerFor(target))
      const identity = { botId, personaId: agentPersonaScopeId(source.agentId) }
      if (target.kind === 'private' && source.kind === 'message' && privatePeerFor(target) !== source.authorId) return false
      if (source.kind !== 'receipt' && await inbox.isRecalled(target, source.nativeId)) return false
      if (source.kind === 'receipt') {
        const character = await cognitionCharacters.load({ botId, personaId: identity.personaId, groupId: scene.id })
        if (!source.nativeId.startsWith('receipt:') || !character.receipts.some(receipt => receipt.id === source.nativeId.slice(8) && receipt.status !== 'pending' &&
          JSON.stringify({ toolName: receipt.toolName, status: receipt.status, summary: receipt.summary, goalId: receipt.goalId ?? null }) === source.content)) return false
      }
      const sceneRule = await personMemory.getSceneRedactions({ identity, scene })
      if (source.occurredAt <= sceneRule.forgottenBefore) return false
      // A send may have used older profile/summary context without per-line references.
      // Conservatively retire that derived expression on a privacy epoch change;
      // raw evidence in unrelated scenes remains available under its own rules.
      if (source.kind === 'self-expression' && source.occurredAt <= sceneRule.invalidatedAt) return false
      for (const subjectId of new Set([source.authorId, ...source.participantIds])) {
        const redactions = await personMemory.getRedactions({ identity, subjectId })
        if (isPersonMemoryRedacted({ scene, authorId: subjectId, messageId: source.nativeId, at: source.occurredAt, excerpt: source.content }, source.content, redactions)) return false
      }
      return guard.isCurrent() && !guard.signal?.aborted && bindingFor(target)?.binding.agentId === source.agentId &&
        !privacyBlocked(platformAccountKey(target.account))
    },
    allowsText: text => options.allowsText?.(text, 'incoming') !== false && options.allowsText?.(text, 'outgoing') !== false && options.allowsToolInput?.(text) !== false,
    ...(options.now ? { now: options.now } : {}),
  })
  async function captureCognition(incoming: IncomingMessage, binding: AgentBindingSnapshot, guard: () => boolean): Promise<void> {
    if (options.cognition?.enabled !== true || !incoming.messageId || !guard() || incoming.parts.some(part => part.kind !== 'text' && part.kind !== 'mention')) return
    const content = incoming.parts.filter(part => part.kind === 'text').map(part => part.text).join('').trim()
    if (!content || content.length > 1600 || matchPersonMemoryCommand(content)) return
    const source: CognitionSource = { id: cognitionSourceId(binding.agentId, binding.target, 'message', incoming.messageId),
      agentId: binding.agentId, conversation: binding.target, kind: 'message', nativeId: incoming.messageId,
      authorId: incoming.sender.id, occurredAt: incoming.occurredAt, content, revision: 1,
      participantIds: [...new Set([incoming.sender.id, ...incoming.mentions.map(user => user.id)])], status: 'active' }
    await cognition.record([source], { isCurrent: guard })
  }
  const groupMemory = createGroupMemory({
    redis: storage, memory: personMemory, config: () => options.groupMemory,
    ...(options.groupMemoryModel ? { model: options.groupMemoryModel } : {}),
    resolve(target) {
      if (!isRunning() || !conversationEnabled(target) || target.kind === 'private') return undefined
      const selected = bindingFor(target)
      return selected && { binding: selected.binding, viewer: createPersonaSnapshot({ botId: personMemoryAddress(target).botId,
        personaId: agentPersonaScopeId(selected.binding.agentId), persona: { ...selected.persona, name: String(selected.persona.name ?? '') },
        systemContent: selected.systemContent, binding: selected.binding }) }
    },
    botUserId: target => adapterFor(target)?.botUserId ?? '',
    available: target => isRunning() && allowsConversationAI(target) && adapterFor(target)?.isReady() === true && !privacyBlocked(platformAccountKey(target.account)),
    members: readGroupMembers, member: readGroupMember,
    isRecalled: inbox.isRecalled, begin: beginMemoryTurn, isRunning,
    allowsText: text => options.allowsText?.(text, 'incoming') !== false && options.allowsText?.(text, 'outgoing') !== false,
    logger, ...(options.recordTokens ? { recordUsage: options.recordTokens } : {}), ...(options.now ? { now: options.now } : {}),
  })
  const groupKnowledge = createGroupKnowledgeTool({
    management: createGroupMemoryManagement({ redis: storage, memory: personMemory, adapter: adapterFor,
      resolve: bindingFor, isRecalled: inbox.isRecalled, ...(options.now ? { now: options.now } : {}) }),
    member: readGroupMember, actions: messageActions,
  })
  // Tool and failure-notice scopes share one source pin, even after an
  // individual tool's signal ends. Weak ownership lasts only for this turn.
  const textInteractionQuotes = new WeakMap<IncomingMessage, { token: string; author: PlatformUserRef; text: string; at: number }>()
  const textRegistry = createAgentTextRegistryTools({
    get builtIn() { return (options.toolRegistry?.builtIn ?? []).filter(tool => isTextRegistryToolName(tool.name)) },
    get custom() { return (options.toolRegistry?.custom ?? []).filter(tool => isTextRegistryToolName(tool.name)) },
  }, {
    signal: toolCancellation.signal, diagnostics, checkCurrent: checkToolCurrent,
    ...(options.allowsToolInput ? { allowsInput: options.allowsToolInput } : {}),
    onStart(event, cancel) {
      const target = (event as AgentBindingTurn)._agentBinding!.target, key = conversationAddressKey(target)
      const callbacks = pendingTools.get(key) ?? new Set<() => void>()
      callbacks.add(cancel); pendingTools.set(key, callbacks)
      return () => { callbacks.delete(cancel); if (!callbacks.size) pendingTools.delete(key) }
    },
  })
  const textConversation = createTextConversation({
    inbox, actions: messageActions, personMemory, diagnostics, checkToolCurrent,
    ...(options.failureNoticeFallback ? { fallbackText: options.failureNoticeFallback } : {}),
    bindingToken: textBindingToken,
    groupToolNames: target => options.groupTextTools?.(target) ?? [],
    privateToolNames: options.privateTextTools ?? [],
    registryTools(target) {
      if (!adapterFor(target)?.readMessage) return []
      const config = defaultSimRuntimeConfig(options.getSection())
      const surface = resolveSimToolSurface({ policy: config.toolPolicy, builtInNames: (options.toolRegistry?.builtIn ?? []).map(tool => tool.name),
        extraTools: config.extraTools, groupId: target.kind === 'group' ? target.id : '' })
      const denied = [...config.toolPolicy.denyTools, ...(target.kind === 'group' ? config.toolPolicy.groups[target.id] ?? [] : [])]
      return textRegistry.list().filter(tool => surface.includes(tool.name) && !denied.includes(tool.name))
    },
    groupTools: createGroupTextTools({ diagnostics, commitment: new commitments.CommitmentTool(), memory: new memories.DelegateMemoryTool(),
      ...(options.groupMemory?.enabled === true ? { knowledge: groupKnowledge } : {}) }),
    ...(options.allowsToolInput ? { allowsToolInput: options.allowsToolInput } : {}),
    async videoSelection(incoming, binding) {
      const session = await createAgentVideoSearchStore(storage, { ...(options.now ? { now: options.now } : {}) }).load(binding)
      if (!session || session.source.messageId !== incoming.messageId || platformAccountKey(session.source.author) !== platformAccountKey(incoming.sender)) return undefined
      return session.generation
    },
    scopedTools(target, toolName) {
      const adapter = adapterFor(target)
      if (!adapter?.readMessage) return []
      const matches = (tool: AgentTool) => toolName === undefined || tool.name === toolName
      const group = target.kind === 'group'
      const builtIn = group ? (options.toolRegistry?.builtIn ?? []).filter(matches) : []
      const magnet = builtIn.filter(tool => tool.name === 'searchMagnetTool' && magnetSearchCurrent())
      const qq = group ? qqActions.builtIn.filter(tool => matches(tool) && supportsQqAction(target, tool.name)) : []
      const video = builtIn.filter(tool => groupTextVideoToolNames.some(name => name === tool.name) &&
        (tool.name === 'searchVideoTool' || tool.name === 'videoShareTool' && !!adapter.actions.sendVideoCard ||
          tool.name === 'videoDownloadTool' && !!adapter.actions.sendMediaRelay) && options.isVideoSearchCurrent?.() !== false)
      const interactions = adapter.actions.interact ? interactionTools.filter(tool => matches(tool) &&
        (group || (tool.name === 'likeTool' || tool.name === 'recallTool') && options.privateTextTools?.includes(tool.name)) &&
        (!['jinyanTool', 'changeCardTool'].includes(tool.name) || !!adapter.readConversationMember && !!adapter.listConversationMembers) &&
        (tool.name !== 'recallTool' || !!adapter.readOwnMessage) && interactionsCurrent()) : []
      return [...magnet, ...qq, ...video, ...interactions]
    },
    scopedContext(incoming, binding, turnCurrent, ensureTurn, signal, registryScope) {
      const target = binding.target, adapter = adapterFor(target), token = textBindingToken(binding), peer = privatePeerFor(target, adapter)
      if (!adapter?.readMessage || !incoming.messageId ||
          !isPlatformAccount(incoming.sender) || !samePlatformNamespace(incoming.sender, target.account) ||
          target.kind === 'private' && (!peer || incoming.sender.id !== peer) ||
          [...adapters.values()].some(row => samePlatformNamespace(row.account, incoming.sender) &&
            [row.account.id, row.botUserId].includes(incoming.sender.id))) return undefined
      const current = () => checkToolCurrent(() => {
        try { const live = bindingFor(target); return !signal.aborted && turnCurrent() &&
          adapterFor(target) === adapter && adapter.isReady() && !!live && textBindingToken(live.binding) === token &&
          (target.kind !== 'private' || !!peer && privatePeerFor(target, adapter) === peer && incoming.sender.id === peer) }
        catch { return false }
      })
      const available = async (source: { readonly messageId: string; readonly author: PlatformUserRef }, expected?: Pick<IncomingMessage, 'text' | 'occurredAt'>) => {
        try {
          await ensureTurn()
          if (!current() || !isMessageId(source.messageId) || !isPlatformAccount(source.author) ||
              !samePlatformNamespace(source.author, target.account) || !await inbox.canReply(target, source.messageId)) return false
          const message = await adapter.readMessage!(target, source.messageId, { isCurrent: current })
          if (!message || !isConversationAddress(message.conversation) || conversationAddressKey(message.conversation) !== conversationAddressKey(target) ||
              message.messageId !== source.messageId || !isPlatformAccount(message.sender) || platformAccountKey(message.sender) !== platformAccountKey(source.author) ||
              !Number.isSafeInteger(message.occurredAt) || message.occurredAt <= 0 || matchPersonMemoryCommand(message.text) || !allowsFileNames(message) ||
              options.allowsText?.(message.text, 'incoming') === false || options.allowsToolInput?.(message.text) === false ||
              source.messageId === incoming.messageId && (message.text !== incoming.text || message.occurredAt !== incoming.occurredAt) ||
              expected && (message.text !== expected.text || message.occurredAt !== expected.occurredAt)) return false
          const { botId, scene } = personMemoryAddress(target, peer), excerpt = message.text || '[工具请求]'
          const redactions = await personMemory.getRedactions({ identity: { botId, personaId: agentPersonaScopeId(binding.agentId) }, subjectId: source.author.id })
          await ensureTurn()
          return current() && await inbox.canReply(target, source.messageId) &&
            !isPersonMemoryRedacted({ scene, messageId: source.messageId, authorId: source.author.id, at: message.occurredAt, excerpt }, excerpt, redactions)
        } catch (error) { diagnostics.emit({ stage: 'tool', operation: 'text_tool_source', outcome: 'failed', code: 'source_read_unavailable', error }); return false }
      }
      const ensure = async () => {
        if (!await available({ messageId: incoming.messageId!, author: incoming.sender })) throw new Error('工具请求来源已失效')
      }
      const request: { messageId: string; text: string; occurredAt: number; mentions: readonly PlatformUserRef[]; replyMessageId?: string; replyAuthor?: PlatformUserRef } = {
        messageId: incoming.messageId, text: incoming.text, occurredAt: incoming.occurredAt, mentions: incoming.mentions,
        ...(incoming.quote?.messageId ? { replyMessageId: incoming.quote.messageId } : {}),
      }
      let interactionQuote = textInteractionQuotes.get(incoming)
      if (interactionQuote?.token !== token) interactionQuote = undefined
      const ensureInteractionQuote = async () => {
        if (!request.replyMessageId) return
        let message: IncomingMessage | undefined
        try {
          await ensure()
          message = await adapter.readMessage!(target, request.replyMessageId, { isCurrent: current })
          if (!message || !isConversationAddress(message.conversation) || conversationAddressKey(message.conversation) !== conversationAddressKey(target) ||
              message.messageId !== request.replyMessageId || !isPlatformAccount(message.sender) || !samePlatformNamespace(message.sender, target.account) ||
              !Number.isSafeInteger(message.occurredAt) || message.occurredAt <= 0 ||
              !await available({ messageId: request.replyMessageId, author: message.sender }, message)) message = undefined
        } catch { message = undefined }
        if (!message) {
          if (interactionQuote) throw new Error('互动引用来源已失效')
          return
        }
        if (interactionQuote && (platformAccountKey(message.sender) !== platformAccountKey(interactionQuote.author) ||
            message.text !== interactionQuote.text || message.occurredAt !== interactionQuote.at)) throw new Error('互动引用来源已改变')
        if (!interactionQuote) {
          interactionQuote = { token, author: Object.freeze({ ...message.sender }), text: message.text, at: message.occurredAt }
          textInteractionQuotes.set(incoming, interactionQuote)
        }
        request.replyAuthor = interactionQuote.author
      }
      const ensureInteraction = async () => { await ensure(); await ensureInteractionQuote(); if (!current()) throw new Error('互动请求来源已失效') }
      const beforeSend = async (guard?: { readonly signal: AbortSignal; isCurrent(): boolean; ensureCurrent?(): Promise<void> }) => {
        await ensure()
        await guard?.ensureCurrent?.()
        if (!current() || guard?.signal.aborted || guard?.isCurrent() === false) throw new Error('工具投递来源已失效')
      }
      const sourceContext = { binding, actor: { kind: 'user' as const, user: incoming.sender }, request, signal, isCurrent: current }
      const ensureSource = async () => { await ensure(); if (textInteractionQuotes.get(incoming)?.token === token) await ensureInteractionQuote() }
      // A previously pinned interaction quote can acquire its reply author during validation.
      const sourceGuard = request.replyMessageId && interactionQuote ? { ...sourceContext, ensureCurrent: ensureSource }
        : createAgentToolSourceGuard(sourceContext, ensureSource)
      const mediaGuard = (toolCurrent: () => boolean, toolSignal: AbortSignal) => ({ signal: AbortSignal.any([signal, toolSignal]),
        isCurrent: () => current() && !toolSignal.aborted && toolCurrent(), async ensureCurrent() {
          await ensureSource(); if (!current() || toolSignal.aborted || !toolCurrent()) throw new Error('文字媒体来源已失效')
        } })
      const genericPorts: AgentTextToolPorts = registryScope ? {
        ...createAgentTextToolSources({ incoming, adapter, signal, now: options.now ?? Date.now, isCurrent: current, ensureCurrent: ensureSource,
          ...(peer ? { privatePeer: peer } : {}), available, registerProjection: registryScope.registerProjection,
          async allowsUnlinkedSource(author, at) {
            await ensureSource()
            if (!isPlatformAccount(author) || !samePlatformNamespace(author, target.account) || !Number.isSafeInteger(at) || at <= 0 || at > incoming.occurredAt ||
                target.kind === 'private' && author.id !== peer || [...adapters.values()].some(row => samePlatformNamespace(row.account, author) && [row.account.id, row.botUserId].includes(author.id))) return false
            const { botId, scene } = personMemoryAddress(target, peer), identity = { botId, personaId: agentPersonaScopeId(binding.agentId) }
            const [privacy, sceneState] = await Promise.all([personMemory.getRedactions({ identity, subjectId: author.id }), personMemory.getSceneRedactions({ identity, scene })])
            const rule = privacy.scenes.find(row => row.scene.kind === scene.kind && row.scene.id === scene.id)
            const inScene = (key: string) => { try { const value = JSON.parse(key); return Array.isArray(value) && value[0] === scene.kind && value[1] === scene.id } catch { return true } }
            if (privacy.disabled || rule?.disabled || at <= privacy.forgottenBefore || at <= (rule?.forgottenBefore ?? 0) ||
                at <= sceneState.invalidatedAt && privacy.revokedSources.some(inScene) || privacy.tombstones.some(row => at <= row.before && (!row.sourceKey || inScene(row.sourceKey)))) return false
            await ensureSource(); return current()
          },
        }),
        ...(adapter.actions.sendFile ? { async sendFile(file, toolCurrent, toolSignal) { const guard = mediaGuard(toolCurrent, toolSignal); await guard.ensureCurrent();
          return messageActions.sendFile!({ version: 1, kind: 'file.upload', target, binding, file }, guard) } } : {}),
        ...(adapter.actions.sendMedia ? {
          async sendAudio(audio, toolCurrent, toolSignal) { const guard = mediaGuard(toolCurrent, toolSignal); await guard.ensureCurrent();
            return messageActions.sendMedia!({ version: 1, kind: 'media.send', target, binding, media: { kind: 'audio', ...audio } }, guard) },
          async sendVideo(video, toolCurrent, toolSignal) { const guard = mediaGuard(toolCurrent, toolSignal); await guard.ensureCurrent();
            return messageActions.sendMedia!({ version: 1, kind: 'media.send', target, binding, media: { kind: 'video', ...video } }, guard) },
        } : {}),
        ...(target.kind === 'group' && adapter.actions.sendMusic ? { async sendMusic(music, toolCurrent, toolSignal) { const guard = mediaGuard(toolCurrent, toolSignal); await guard.ensureCurrent();
          return messageActions.sendMusic!({ version: 1, kind: 'music.send', target, binding, music }, guard) } } : {}),
      } : {}
      return {
        ...sourceGuard, botUserId: adapter.botUserId,
        ...(registryScope ? { [agentTextToolPorts]: genericPorts, persona: registryScope.persona,
          recordUsage(model: string, usage: unknown) { options.recordTokens?.({ scope: simulationAddressKey(target), stage: 'agent-tool', model, usage }) },
          async sendImage(image, guard) {
            await beforeSend(guard)
            return messageActions.send({ version: 1, kind: 'message.send', target, binding,
              parts: [{ kind: 'image', resource: { kind: 'reference', value: `base64://${image.base64}` }, ...(image.presentation ? { presentation: image.presentation } : {}) }] },
              { isCurrent: () => current() && guard?.isCurrent() !== false && !guard?.signal.aborted, ensureCurrent: () => beforeSend(guard) })
          },
          ...(adapter.actions.sendBundle ? { async sendBundle(items, guard) {
            await beforeSend(guard)
            return messageActions.sendBundle!({ version: 1, kind: 'message.bundle.send', target, binding, items },
              { isCurrent: () => current() && guard?.isCurrent() !== false && !guard?.signal.aborted, ensureCurrent: () => beforeSend(guard) })
          } } : {}),
        } : {}),
        ...(target.kind === 'private' && peer ? { privatePeer: Object.freeze({ ...target.account, id: peer }) } : {}),
        ...(target.kind === 'group' && adapter.readConversationMember ? {
          readMember: async (userId: string) => { await ensureInteraction(); return readGroupMember(target, userId, signal, current) },
        } : {}),
        ...(target.kind === 'group' && adapter.listConversationMembers ? {
          listMembers: async () => { await ensureInteraction(); return readGroupMembers(target, signal, current) },
        } : {}),
        isSourceAvailable: available,
        ...(interactionsCurrent() && adapter.actions.interact ? {
          interact: async (plan: AgentInteractionPlan) => { await ensureInteraction(); return performInteractions({ target, binding, identity: 'human:' + incoming.messageId,
            source: { messageId: incoming.messageId!, author: incoming.sender, occurredAt: incoming.occurredAt, text: incoming.text },
            plan, signal, isCurrent: current, ensureCurrent: ensureInteraction }) },
        } : {}),
        ...(target.kind === 'group' && adapter.actions.sendVideoCard ? { async sendVideoCard(card, guard) {
          const owned = validateAgentVideoCard(card, text => options.allowsToolInput?.(text) !== false && options.allowsText?.(text, 'outgoing') !== false)
          await beforeSend(guard)
          return messageActions.sendVideoCard!({ version: 1, kind: 'video-card.send', target, binding, card: owned },
            { signal: AbortSignal.any([signal, ...(guard ? [guard.signal] : [])]), isCurrent: () => current() && guard?.isCurrent() !== false,
              ensureCurrent: () => beforeSend(guard) })
        } } : {}),
        ...(target.kind === 'group' && adapter.actions.sendMediaRelay ? { async sendMediaRelay(plan, guard) {
          const owned = validateAgentMediaRelayPlan(plan, { allowsText: text => options.allowsToolInput?.(text) !== false &&
            sanitizeFinalReplyText(text) === text && options.allowsText?.(text, 'outgoing') !== false })
          const text = owned.items.flatMap(item => item.parts.flatMap(part => part.kind === 'text' ? [part.text] : [])).join('\n')
          if (options.allowsToolInput?.(text) === false || options.allowsText?.(text, 'outgoing') === false) throw new Error('视频文字不可用')
          await beforeSend(guard)
          return messageActions.sendMediaRelay!({ version: 1, kind: 'media-relay.send', target, binding, mode: 'forward', plan: owned },
            { signal: AbortSignal.any([signal, ...(guard ? [guard.signal] : [])]), isCurrent: () => current() && guard?.isCurrent() !== false,
              ensureCurrent: () => beforeSend(guard) })
        } } : {}),
      }
    },
    learnConfirmed: (incoming, binding, isCurrent) => textPersonMemory.enqueue(incoming, binding, isCurrent),
    async readConversationMemory(incoming, viewer, isCurrent) {
      const selected = bindingFor(incoming.conversation)
      if (!selected) return { digest: '', episodes: '' }
      return conversationMemory.read(selected.binding, viewer, isCurrent, { userId: incoming.sender.id, query: incoming.text })
    },
    async readGroupMemory(incoming, _viewer, isCurrent) {
      const selected = bindingFor(incoming.conversation)
      return selected ? groupMemory.prepare(selected.binding, incoming.messageId, isCurrent) : ''
    },
    async readSemanticMemory(incoming, isCurrent, signal) {
      const selected = bindingFor(incoming.conversation)
      const query = incoming.parts.filter(part => part.kind === 'text').map(part => part.text).join('')
      return selected ? semanticMemory.read(selected.binding, query, isCurrent, signal, incoming.messageId ? [incoming.messageId] : [],
        incoming.conversation.kind === 'private' && incoming.messageId ? {
          messageId: incoming.messageId, authorId: incoming.sender.id, at: incoming.occurredAt,
        } : undefined) : undefined
    },
    ...(options.cognition?.enabled === true ? {
      async readCognition(incoming: IncomingMessage, guard: CognitionGuard) {
        const selected = bindingFor(incoming.conversation)
        return selected ? cognition.recall({ agentId: selected.binding.agentId, conversation: incoming.conversation, text: incoming.text }, guard) : undefined
      },
      async recordCognitionReply(incoming: IncomingMessage, binding: AgentBindingSnapshot, reply: string, replyId: string, guard: CognitionGuard, contextNodeIds: readonly string[]) {
        if (!incoming.messageId || incoming.conversation.kind !== 'group') return
        const { botId, scene } = personMemoryAddress(binding.target)
        await cognition.projectTurn({ agentId: binding.agentId, conversation: binding.target,
          character: { schemaVersion: 1, scope: { botId, personaId: agentPersonaScopeId(binding.agentId), groupId: scene.id }, revision: 0, paused: false, memories: [], goals: [], receipts: [] },
          messageRefs: [{ seq: 0, messageId: incoming.messageId }], contextNodeIds,
          preserveCharacter: true,
          expressions: [{ messageId: replyId, content: reply, at: options.now?.() ?? Date.now(), participantIds: [binding.target.account.id] }],
        }, guard)
      },
    } : {}),
    ...(options.history?.enabled === true ? { async readHistory(incoming: IncomingMessage, input: Record<string, unknown>, guard: () => boolean, signal?: AbortSignal) {
      const selected = bindingFor(incoming.conversation)
      if (!selected || !incoming.messageId) throw new Error('历史查询缺少当前真实消息')
      return history.read(selected.binding, input, { messageId: incoming.messageId, authorId: incoming.sender.id,
        text: incoming.text, at: incoming.occurredAt, mentions: incoming.mentions,
      }, guard, signal)
    } } : {}),
    async isGroupMemoryCurrent(incoming, expected, guard) {
      const selected = bindingFor(incoming.conversation)
      return !!selected && guard() && await groupMemory.read(selected.binding, guard, true) === expected && guard()
    },
    async recordGroupReply(incoming, binding, guard) {
      if (incoming.conversation.kind === 'group') try { await groupMemory.confirmed(binding, guard) } catch (error) { diagnostics.emit({ stage: 'memory', operation: 'group_learning_confirm', outcome: 'failed', code: 'confirmed_reply_record_failed', error }) }
    },
    async recordEpisode(incoming, source, reply, replyId, isCurrent) {
      if (!source.binding || !incoming.messageId) return
      await conversationMemory.recordEpisode({ binding: source.binding, source, at: options.now?.() ?? Date.now(),
        userId: incoming.sender.id, userName: incoming.senderName ?? '', summary: incoming.text.slice(0, 120), reply,
        messageIds: [incoming.messageId], replyIds: [replyId],
        ...(incoming.conversation.kind === 'private' ? { peerId: incoming.sender.id } : {}),
      }, isCurrent)
    },
    isPrivatePeer: (target, sender) => sender.id === privatePeerFor(target),
    allowsText: text => options.allowsText?.(text, 'outgoing') !== false && options.allowsText?.(text, 'incoming') !== false,
    async reserveGroupTurn(target, now) {
      const budget = await runtime.groupTextBudget(target, now)
      if (budget.dailyCostCny > 0 && budget.todayCostCny >= budget.dailyCostCny) return false
      return await inbox.reserveGroupTextTurn(target, dayKey(now), budget.maxTurns, budget.minGapMs, budget.carriedTurns)
    },
    async model(request, target, signal, isCurrent, ensureCurrent) {
      const response = await options.YTapi(request, options.getExecutionConfig(), signal, isCurrent, ensureCurrent)
      if (target.kind === 'group' && !response.error) {
        options.recordTokens?.({ scope: simulationAddressKey(target), stage: 'group-text', model: String(response.model ?? ''), usage: response.usage })
      }
      return response
    },
    ...(options.now ? { now: options.now } : {}),
  })

  const triggerModels = options.textTriggerModel && createAgentTextTriggerModels({
    model: options.textTriggerModel, diagnostics,
    allowsText: text => options.allowsText?.(text, 'incoming') !== false && options.allowsText?.(text, 'outgoing') !== false,
    ...(options.now ? { now: options.now } : {}),
  })
  const textTrigger = createAgentTextTrigger<ResolvePersona>({
    config: () => options.textTrigger,
    ...(options.now ? { now: options.now } : {}),
    random: Math.random,
    async readHistory(input, guard) {
      await guard.ensureCurrent()
      const { binding, persona, systemContent } = input.selected
      const target = input.incoming.conversation, { botId, scene } = personMemoryAddress(target)
      const identity = { botId, personaId: agentPersonaScopeId(binding.agentId) }
      const snapshot = createPersonaSnapshot({ ...identity, binding, persona: { ...persona, name: String(persona.name ?? '') }, systemContent })
      const [saved, redactions] = await Promise.all([inbox.loadTextHistory(target), personMemory.getSceneRedactions({ identity, scene })])
      await guard.ensureCurrent()
      return saved?.bindingToken === textBindingToken(binding) && saved.personaVersion === snapshot.personaVersion &&
        (saved.personMemoryInvalidatedAt ?? 0) === redactions.invalidatedAt ? saved.turns : []
    },
    async gate(input, guard) {
      if (!triggerModels) return { decision: 'no_action', reason: 'gate_unconfigured' }
      const { binding, persona, systemContent } = input.selected
      const snapshot = createPersonaSnapshot({ botId: personMemoryAddress(binding.target).botId, personaId: agentPersonaScopeId(binding.agentId),
        binding, persona: { ...persona, name: String(persona.name ?? '') }, systemContent })
      return triggerModels.gate({ ...guard, binding, incoming: input.incoming, persona: snapshot,
        history: input.history.flatMap(turn => [{ speakerId: turn.speakerId ?? '', text: turn.user }, { speakerId: binding.target.account.id, text: turn.reply }]),
        phase: input.decision.phase, reason: input.decision.reason, recentReplies: input.decision.stats.recentReplyCount,
        recentIncoming: input.decision.stats.groupMsgRate5min,
        ...(input.metrics.lastReplyAt ? { lastReplyAt: input.metrics.lastReplyAt } : {}),
        ...(input.metrics.lastReplyToUserId ? { lastReplyToUserId: input.metrics.lastReplyToUserId } : {}),
        promptHintBusyGroupRate: options.textTrigger?.smart?.promptHintBusyGroupRate ?? 30,
        promptHintRateLimitWarn: options.textTrigger?.smart?.promptHintRateLimitWarn ?? 5,
      })
    },
    async tracking(input, guard) {
      if (!triggerModels) return false
      const { binding, persona, systemContent } = input.selected
      const snapshot = createPersonaSnapshot({ botId: personMemoryAddress(binding.target).botId, personaId: agentPersonaScopeId(binding.agentId),
        binding, persona: { ...persona, name: String(persona.name ?? '') }, systemContent })
      return triggerModels.tracking({ ...guard, binding, incoming: input.incoming, persona: snapshot, history: input.history })
    },
    async reply(input, guard) {
      return diagnostics.run({ kind: 'conversation', binding: input.selected.binding, messageId: input.incoming.messageId! }, 'text_turn',
        () => textConversation.replyWithTrigger(input.incoming, input.selected, guard.isCurrent, guard.signal,
          { reason: input.reason, sources: input.sources, quote: input.quote, ensureCurrent: guard.ensureCurrent,
            ...(input.repeatText === undefined ? {} : { repeatText: input.repeatText }) }), 'inbox')
    },
    async repeat(input, guard) {
      return textConversation.replyWithTrigger(input.incoming, input.selected, guard.isCurrent, guard.signal,
        { reason: 'repeat', sources: input.sources, quote: false, ensureCurrent: guard.ensureCurrent,
          ...(input.repeatText === undefined ? {} : { repeatText: input.repeatText }) })
    },
  })

  const localEmojiIngress = options.collectMessageSticker ? createAgentLocalEmojiIngress({
    collect: options.collectMessageSticker,
    enabled: () => isRunning() && options.autoCollectLocalEmoji === true && options.isLocalEmojiCurrent?.() !== false,
    allowsText: text => options.allowsToolInput?.(text) !== false && options.allowsText?.(text, 'incoming') !== false,
  }) : undefined
  function enqueueLocalEmoji(source: IncomingMessage, binding: AgentBindingSnapshot, adapter: PlatformConnectionAdapter): void {
    if (!localEmojiIngress || !source.messageId || !source.parts.some(part => part.kind === 'image') || source.sender.id === binding.target.account.id ||
        !adapter.readMessageImages || options.autoCollectLocalEmoji !== true) return
    const target = binding.target, token = agentBindingToken(binding), lifetime = new AbortController()
    let memory: Awaited<ReturnType<typeof beginMemoryTurn>> | undefined
    const current = () => observeCurrent(() => !lifetime.signal.aborted && memory?.isCurrent() !== false && isRunning() &&
      options.isLocalEmojiCurrent?.() !== false && adapterFor(target) === adapter && adapter.isReady() &&
      conversationEnabled(target) && allowsConversationAI(target) && bindingIsCurrent(target, token))
    const ensureCurrent = async () => {
      if (!current()) throw new Error('自动收藏所属会话已失效')
      if (!memory) {
        const captured = await beginMemoryTurn(binding)
        if (lifetime.signal.aborted) { captured.release(); throw new Error('自动收藏已取消') }
        memory = captured
      }
      if (!current() || await inbox.isRecalled(target, source.messageId!)) throw new Error('自动收藏来源已撤回')
      const { botId, scene } = personMemoryAddress(target), excerpt = source.text || '[图片]'
      const redactions = await personMemory.getRedactions({ identity: { botId, personaId: agentPersonaScopeId(binding.agentId) }, subjectId: source.sender.id })
      if (!current() || isPersonMemoryRedacted({ scene, messageId: source.messageId!, authorId: source.sender.id,
          at: source.occurredAt, excerpt }, excerpt, redactions)) throw new Error('自动收藏来源隐私权限已改变')
    }
    localEmojiIngress.enqueue({ binding, source: { ...source, binding },
      guard: { signal: toolCancellation.signal, isCurrent: current, ensureCurrent },
      release() { lifetime.abort(); memory?.release() },
      read: guard => adapter.readMessageImages!(target, source.messageId!, { ...guard, async allowsSource(original) {
        await guard.ensureCurrent()
        return original.messageId === source.messageId && conversationAddressKey(original.conversation) === conversationAddressKey(target) &&
          platformAccountKey(original.sender) === platformAccountKey(source.sender) && original.occurredAt === source.occurredAt &&
          original.text === source.text && options.allowsText?.(original.text, 'incoming') !== false && allowsFileNames(original) && guard.isCurrent()
      } }),
    })
  }
  const consumers = new Map<string, Promise<void>>()
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  let maintenance: ReturnType<typeof setInterval> | undefined
  let shuttingDown: Promise<void> | undefined
  let started = false

  function accept(adapter: PlatformConnectionAdapter, event: PlatformConversationEvent): Promise<void> {
    // Admission order is assigned before any member/storage await, so later messages
    // cannot overtake an on/off/export command from this receiving account.
    const key = platformAccountKey(adapter.account)
    const ordered = event.kind === 'message' && event.message.conversation.kind === 'group' && !personMemoryCommand(event.message) &&
      (groupLogEnabled || diceCandidate(event.message) || gameCandidate(event.message))
    const previous = ordered ? admissions.get(key) ?? Promise.resolve() : undefined
    const task = (previous ? previous.catch(() => {}).then(() => acceptEvent(adapter, event)) : acceptEvent(adapter, event)).catch(error => {
      diagnostics.emit({ stage: 'inbox', operation: 'admit_event', outcome: 'failed', code: 'admission_not_confirmed', error })
      throw error
    })
    if (ordered) admissions.set(key, task)
    pendingAdmissions.add(task)
    void task.finally(() => { pendingAdmissions.delete(task); if (admissions.get(key) === task) admissions.delete(key) }).catch(() => {})
    return task
  }
  async function acceptEvent(adapter: PlatformConnectionAdapter, event: PlatformConversationEvent): Promise<void> {
    if (!isRunning()) throw new Error('独立宿主正在停止')
    const target = inboxEventTarget(event)
    if (!isConversationAddress(target) || adapterFor(target) !== adapter || !adapter.isReady() || !hasValidInboundEvent(event, adapter)) return
    const privateChat = target.kind === 'private'
    if (event.kind === 'red-packet') {
      const binding = bindingFor(target)?.binding
      if (!binding || !adapter.redPackets || !qqActionsCurrent(binding) || !options.qqActions?.redPackets?.automatic?.enabled) return
      const epochs = await groupLogs.capture({ target, agentId: binding.agentId }, event.packet.source.author.id)
      const memory = await beginMemoryTurn(binding), key = conversationAddressKey(target), packet = structuredClone(event.packet)
      const previous = automaticQqWork.get(key) ?? Promise.resolve()
      const work = previous.catch(() => {}).then(async () => {
        const current = () => observeCurrent(() => memory.isCurrent() && qqActionsCurrent(binding) && adapterFor(target) === adapter)
        const guard: AgentQqActionGuard = { signal: memory.signal, isCurrent: current, async ensureCurrent() {
          if (!current() || await inbox.isRecalled(target, packet.source.messageId)) throw new Error('红包来源已失效')
          const latest = await groupLogs.capture({ target, agentId: binding.agentId }, packet.source.author.id)
          if (!current() || latest.globalEpoch !== epochs.globalEpoch || latest.sceneEpoch !== epochs.sceneEpoch) throw new Error('红包来源隐私权限已改变')
        } }
        await diagnostics.run({ kind: 'conversation', binding, messageId: packet.source.messageId }, 'red_packet_automatic', async () => {
          await guard.ensureCurrent()
          const result = await qqActions.automatic(packet, binding, guard)
          diagnostics.emit({ stage: 'delivery', operation: 'red_packet_automatic', outcome: result.state === 'confirmed' ? 'succeeded' :
            result.state === 'unknown' ? 'unknown' : result.state === 'failed' ? 'failed' : 'cancelled', code: result.code })
        }, 'runtime')
      }).catch(error => { diagnostics.emit({ stage: 'runtime', operation: 'red_packet_automatic', outcome: 'cancelled', code: 'source_unavailable', error }) })
        .finally(() => { memory.release(); if (automaticQqWork.get(key) === work) automaticQqWork.delete(key) })
      automaticQqWork.set(key, work)
      return
    }
    if (event.kind === 'recall') {
      textTrigger.invalidateAccount(target.account)
      adapter.redPackets?.revoke(target, event.messageId)
      bilibiliQuality?.invalidateSource(target, event.messageId)
      groupLogWorkflow.invalidate(target)
      textPersonMemory.invalidate(target)
      conversationMemory.invalidate(target)
      semanticMemory.invalidate(target)
      history.invalidate(target)
      groupMemory.invalidate(target)
      // A recalled source may have been retrieved by another turn in this account.
      for (const invalidate of memoryTurns.get(platformAccountKey(target.account))?.keys() ?? []) invalidate()
      for (const invalidate of pendingSends.get(conversationAddressKey(target)) ?? []) invalidate()
      for (const invalidate of pendingTools.get(conversationAddressKey(target)) ?? []) invalidate()
      // Each workflow revokes its in-memory owners synchronously. A failing ledger cannot prevent sibling fences.
      const results = await Promise.allSettled([
        ...(options.localEmojiCleanup ? [completeLocalEmojiCleanup(guard =>
          options.localEmojiCleanup!.revokeSource({ target, messageId: event.messageId }, guard))] : []),
        ...(options.cognition?.enabled === true && bindingFor(target) ? [cognition.invalidate(bindingFor(target)!.binding.agentId, {
          id: `recall:${conversationAddressKey(target)}:${event.messageId}`, account: target.account, conversation: target, before: Number.MAX_SAFE_INTEGER,
          sourceIds: ['message', 'self-expression'].map(kind => cognitionSourceId(bindingFor(target)!.binding.agentId, target, kind as 'message' | 'self-expression', event.messageId)),
        }, { isCurrent: isRunning })] : []),
        ...(target.kind === 'group' ? [groupLogs.revokeSource(target, event.messageId), revokeDiceSource(target, event.messageId)] : []),
        ...(mediaRelayConfig.enabled ? [mediaOutbox.cancelSource(target, event.messageId)] : []),
        ...(torrentConfig.enabled ? [torrent.cancelSource(target, event.messageId)] : []),
        (async () => {
          const received = await inbox.canReply(target, event.messageId)
          const binding = received ? undefined : bindingFor(target)?.binding
          if (!received && !binding) return
          if ((target.kind === 'group' || privateChat) && await inbox.recallText(target, event.messageId)) textConversation.invalidate(target)
          const queue = privateChat ? undefined : await inbox.accept({ event })
          const { botId, scene } = personMemoryAddress(target)
          await revokePersonMemorySourceForAccount(personMemory, botId, scene, event.messageId, binding && agentPersonaScopeId(binding.agentId))
          if (queue) kickInbox(queue)
        })(),
      ])
      const rejected = results.find(result => result.status === 'rejected')
      if (rejected?.status === 'rejected') throw rejected.reason
      return
    }
    if (event.kind === 'message') {
      if (target.kind === 'group' && event.message.messageId && (!diceCurrent() || !diceCandidate(event.message)) &&
          (diceRevocationCandidate(event.message) || await diceState.hasSourceByTarget(target, event.message.messageId))) {
        await revokeDiceSource(target, event.message.messageId)
      }
      const request = personMemoryCommand(event.message)
      if (request) {
        const { sender, binding, messageId, occurredAt } = event.message
        const age = (options.now?.() ?? Date.now()) - occurredAt
        if (!conversationEnabled(target) || !request.standalone || !messageId || age >= privacyCommandMaxAgeMs || age < -privacyCommandClockSkewMs ||
            (target.kind !== 'group' && !privateChat) ||
            (privateChat && sender.id !== privatePeerFor(target, adapter))) return
        const persona = bindingFor(target)
        if (!persona || (binding && !isSameBinding(binding, persona.binding))) return
        const text = personMemoryCommandText[request.command]
        const commandEvent = { kind: 'message' as const, message: { version: 1 as const, conversation: target, sender,
          messageId, occurredAt, text, parts: [{ kind: 'text' as const, text }], mentions: [], directedToAccount: privateChat } }
        const accountKey = platformAccountKey(target.account)
        const finishAdmission = beginPrivacyAdmission(persona.binding)
        try {
          const privacyQueue = await inbox.accept({
            event: commandEvent, bindingToken: agentBindingToken(persona.binding), privacyCommand: request.command,
            privacyOwner: { agentId: persona.binding.agentId },
          }, undefined, pending => setPrivacyBacklog(accountKey, pending))
          kickInbox(privacyQueue)
        } catch (error) {
          // Storage may have accepted the row before losing its reply. Rebuild the fence
          // from the account queue rather than opening it on an uncertain acceptance.
          setPrivacyBacklog(accountKey, true)
          kickInbox({ account: target.account, kind: 'privacy' })
          throw error
        } finally {
          finishAdmission()
        }
        return
      }
    }
    if (target.kind === 'group' && event.kind === 'message' && (groupLogEnabled || diceCandidate(event.message) || gameCandidate(event.message))) {
      const persona = bindingFor(target), message = event.message
      if (!persona || !message.messageId || message.binding && !isSameBinding(message.binding, persona.binding) ||
          options.allowsText?.(message.text, 'incoming') === false || !allowsFileNames(message)) return
      const command = parseAgentGroupLogCommand(message.text)
      const standalone = !message.quote && !message.mentions.length && message.parts.length > 0 &&
        message.parts.every(part => part.kind === 'text') && message.parts.map(part => part.kind === 'text' ? part.text : '').join('') === message.text
      if (groupLogEnabled && standalone && (command?.kind === 'start' || command?.kind === 'ai' && command.enabled === false)) {
        const controller = new AbortController(), token = agentBindingToken(persona.binding)
        try {
          if (await groupLogAuthorized(message, persona.binding, controller.signal, () => isRunning() && bindingIsCurrent(target, token))) {
            const state = await groupLogs.read({ target, agentId: persona.binding.agentId })
            if (command.kind === 'start' || state.active) {
              const key = conversationAddressKey(target), reserved = silenceReservations.get(key) ?? { target, messages: new Set<string>(), admitting: new Set<string>() }
              reserved.messages.add(message.messageId); reserved.admitting.add(message.messageId); silenceReservations.set(key, reserved)
              setConversationAI(target, false)
            }
          }
        } catch (error) {
          diagnostics.emit({ stage: 'runtime', operation: 'group_log_authority', outcome: 'failed', code: 'authority_observation_failed', error })
        } finally { controller.abort() }
      }
      try {
      const epochs = await groupLogs.capture({ target, agentId: persona.binding.agentId }, message.sender.id)
      const parts = message.parts.map(part => part.kind === 'image' || part.kind === 'audio' || part.kind === 'video' ? { kind: part.kind } :
        part.kind === 'file' ? { kind: 'file' as const, ...(part.name ? { name: part.name.slice(0, 255) } : {}) } : part)
      const { binding: _binding, quote, ...source } = message
      const queued = { kind: 'message' as const, message: mediaSafeMessage({ ...source, parts,
        ...(quote ? { quote: { ...(isMessageId(quote.messageId) ? { messageId: quote.messageId } : {}), parts: [] } } : {}) }) }
      const queue = await inbox.accept({ event: queued, bindingToken: agentBindingToken(persona.binding) }, undefined, undefined,
        { kind: 'group-log', groupLog: { agentId: persona.binding.agentId, ...epochs,
          ...(diceCandidate(message) ? { dicePolicy } : {}) } })
      enqueueLocalEmoji(message, persona.binding, adapter)
      silenceReservations.get(conversationAddressKey(target))?.admitting.delete(message.messageId)
      kickInbox(queue)
      } finally { silenceReservations.get(conversationAddressKey(target))?.admitting.delete(message.messageId) }
      return
    }
    if (!conversationEnabled(target) || !allowsConversationAI(target)) return
    if (event.kind === 'message') {
      const selected = bindingFor(target)?.binding
      if (selected) enqueueLocalEmoji(event.message, selected, adapter)
    }
    const queue = textInboxFor(target)
    let queued = event
    if (queue) {
      if (event.kind !== 'message') return
      const { sender, occurredAt, messageId, quote, directedToAccount } = event.message
      if (privateChat && sender.id !== privatePeerFor(target, adapter)) return
      const text = event.message.text.trim()
      const qualityCommand = bilibiliQualityCurrent() && isAgentBilibiliQualityCommand(event.message)
      const magnetCommand = magnetSearchCurrent() && !!parseAgentMagnetSearchCommand(event.message.text)
      const extractionCandidate = extraction.isCandidate(event.message), extractionCommand = extraction.isCommand(event.message)
      const mediaCandidate = isMediaRelayCandidate(event.message)
      if (!text && !extractionCandidate && !mediaCandidate || text.startsWith('#') || (text && !privateChat && '.\\/'.includes(text.charAt(0)) && !extractionCommand && !qualityCommand && !magnetCommand)) return
      const quoteId = isMessageId(quote?.messageId) ? quote.messageId : undefined
      const message: IncomingMessage = {
        version: 1, conversation: target, sender, occurredAt, text,
        ...(messageId ? { messageId } : {}), parts: event.message.parts.filter(part => part.kind === 'text' || qualityCommand && part.kind === 'mention' || part.kind === 'forward' || part.kind === 'file' || (extractionCandidate || mediaCandidate) && part.kind === 'extension').map(part => part.kind === 'file' ? { kind: 'file' as const, ...(part.name ? { name: part.name.slice(0, 255) } : {}) } : part),
        ...(event.message.senderName ? { senderName: event.message.senderName } : {}),
        mentions: event.message.mentions, directedToAccount: privateChat || directedToAccount,
        ...(qualityCommand && quote ? { quote: { ...(quoteId ? { messageId: quoteId } : {}), parts: [] } }
          : (!privateChat || extractionCommand || interactionsCurrent() && options.privateTextTools?.includes('recallTool')) && quoteId
            ? { quote: { messageId: quoteId, parts: [] } } : {}),
      }
      // Explicit commands retain their complete neutral source. Its original
      // text and structure must match the adapter's later authoritative read.
      queued = { kind: 'message', message: qualityCommand || magnetCommand ? event.message : message }
    } else if (event.kind === 'message') {
      const { binding: _binding, quote, ...incoming } = event.message
      const reloadImages = !!adapter.readMessageImages
      const parts = incoming.parts.map(part =>
        part.kind === 'image' && (reloadImages || part.resource?.kind === 'reference') ? { kind: 'image' as const } :
        part.kind === 'video' ? { kind: 'video' as const } :
        part.kind === 'file' ? { kind: 'file' as const, ...(part.name ? { name: part.name.slice(0, 255) } : {}) } : part)
      queued = { kind: 'message', message: {
        ...incoming, parts, ...quoteReference(quote),
      } }
    }
    const persona = bindingFor(target)
    if (!persona) return
    if (event.kind === 'message' && event.message.binding && !isSameBinding(event.message.binding, persona.binding)) return
    if (event.kind === 'message' && (options.allowsText?.(event.message.text, 'incoming') === false || !allowsFileNames(event.message))) {
      if (queue) textConversation.invalidate(target)
      return
    }
    if (queued.kind === 'message') queued = { ...queued, message: mediaSafeMessage(queued.message) }
    const inboxQueue = await inbox.accept({ event: queued, bindingToken: queue ? textBindingToken(persona.binding) : agentBindingToken(persona.binding) }, queue)
    kickInbox(inboxQueue)
  }

  async function applyPrivacyCommand(incoming: IncomingMessage, command: PersonMemoryCommand, token: string | undefined,
    raw: string, adapter: PlatformConnectionAdapter, privacyOwner?: { readonly agentId: string }): Promise<boolean> {
    const { conversation: target, messageId, sender } = incoming
    const kind = target.kind
    let persona = bindingFor(target)
    if ((kind !== 'group' && kind !== 'private') || !messageId) return true
    const state = await inbox.privacyCommandState(target, messageId, raw)
    if (!state) return true
    const originalAgentId = privacyOwner?.agentId ?? (persona && agentBindingToken(persona.binding) === token ? persona.binding.agentId : undefined)
    let emojiCleanupUnsupported = false
    const purge = async () => {
      if (!originalAgentId || command === 'enable') return
      adapter.invalidateRedPacketSources?.()
      groupLogWorkflow.invalidateAccount(target.account)
      const subject = { account: target.account, agentId: originalAgentId, subjectId: sender.id,
        ...(kind === 'group' ? { target } : {}) }
      const results = await Promise.allSettled([
        ...(options.localEmojiCleanup ? [completeLocalEmojiCleanup(guard => options.localEmojiCleanup!.purgeSubject({
          ...subject, through: incoming.occurredAt,
        }, guard), sourceCleanupGuard(() => true, async () => {
          if (await inbox.privacyCommandState(target, messageId, raw) !== 'applied') throw new Error('隐私指令尚未提交')
        })).then(receipt => { emojiCleanupUnsupported = receipt.cleanup === 'unsupported' })] : []),
        completeSemanticMemoryCleanup({ ...subject, through: incoming.occurredAt }, sourceCleanupGuard(() => true, async () => {
          if (await inbox.privacyCommandState(target, messageId, raw) !== 'applied') throw new Error('隐私指令尚未提交')
        })),
        completeConversationMemoryCleanup({ ...subject, through: incoming.occurredAt }, sourceCleanupGuard(() => true, async () => {
          if (await inbox.privacyCommandState(target, messageId, raw) !== 'applied') throw new Error('隐私指令尚未提交')
        })),
        completeSourceMemoryCleanup({ ...subject, through: incoming.occurredAt }, sourceCleanupGuard(() => true, async () => {
          if (await inbox.privacyCommandState(target, messageId, raw) !== 'applied') throw new Error('隐私指令尚未提交')
        })),
        completeGroupMemoryCleanup({ ...subject, through: incoming.occurredAt }, sourceCleanupGuard(() => true, async () => {
          if (await inbox.privacyCommandState(target, messageId, raw) !== 'applied') throw new Error('隐私指令尚未提交')
        })),
        ...(options.cognition?.enabled === true ? [cognition.invalidate(originalAgentId, {
          id: `privacy:${conversationAddressKey(target)}:${messageId}:${command}`, account: target.account, authorId: sender.id,
          ...(kind === 'group' ? { conversation: target } : {}), before: incoming.occurredAt,
        }, { isCurrent: isRunning })] : []),
        groupLogs.purgeSubject({ account: target.account, agentId: originalAgentId, subjectId: sender.id,
          ...(kind === 'group' ? { groupId: target.id } : {}) }),
        diceState.purgeSubject(subject), diceLedger.purgeSubject(subject),
      ])
      const rejected = results.find(result => result.status === 'rejected')
      if (rejected?.status === 'rejected') throw rejected.reason
    }
    // Completing an already committed deletion belongs to its original owner,
    // even if the binding or the command's recall status changed after the crash.
    if (state === 'applied') await purge()
    if (!conversationEnabled(target) || !persona || agentBindingToken(persona.binding) !== token || await inbox.isRecalled(target, messageId)) return true
    if (kind === 'private' && !adapter.isReady()) return false
    const isCurrent = () => isRunning() && conversationEnabled(target) && typeof token === 'string' && bindingIsCurrent(target, token) &&
      (kind === 'group' || sender.id === privatePeerFor(target, adapter))
    if (!isCurrent()) return true
    if (state === 'pending') {
      const { botId, scene } = personMemoryAddress(target)
      const identity = { botId, personaId: agentPersonaScopeId(persona.binding.agentId) }
      try {
        await personMemory.applyPrivacyCommand({ identity, subjectId: sender.id, command,
          ...(kind === 'group' ? { scene } : {}) }, inbox.privacyCommandReceipt(target, messageId, raw), isCurrent)
      } catch (error) {
        if (isRunning() && (!isCurrent() || await inbox.isRecalled(target, messageId) ||
            !await inbox.privacyCommandState(target, messageId, raw))) return true
        throw error
      }
      if (await inbox.privacyCommandState(target, messageId, raw) === 'applied') await purge()
    }
    persona = bindingFor(target)
    if (!persona || !isCurrent()) return true
    if (!adapter.isReady()) return false
    const confirmation = guardPendingSend(conversationAddressKey(target), isCurrent)
    try {
      if (!confirmation.isCurrent() || !await inbox.claimPrivacyConfirmation(target, messageId, raw)) return true
      const text = sanitizeFinalReplyText(privacyConfirmations[command][kind] +
        (emojiCleanupUnsupported ? '\n缺少原始来源的旧表情已停用，清理归属仍待核对。' : ''))
      if (text && confirmation.isCurrent()) {
        await controlMessageActions.send({ version: 1, kind: 'message.send', target, binding: persona.binding,
          parts: [{kind: 'text', text}], ...(kind === 'group' ? { replyTo: messageId } : {}) }, { isCurrent: confirmation.isCurrent })
      }
    } finally {
      confirmation.release()
    }
    return true
  }

  function torrentCurrent(): boolean {
    try { return torrentConfig.enabled && options.torrentDownload?.enabled === true && options.isTorrentDownloadCurrent?.() !== false && isRunning() }
    catch { return false }
  }
  function sameTorrentSource(message: IncomingMessage, target: ConversationAddress, expected: AgentTorrentSource): boolean {
    return isConversationAddress(message.conversation) && conversationAddressKey(message.conversation) === conversationAddressKey(target) &&
      message.messageId === expected.messageId && message.occurredAt === expected.occurredAt && platformAccountKey(message.sender) === platformAccountKey(expected.sender)
  }
  async function torrentSourceAllowed(message: IncomingMessage, binding: AgentBindingSnapshot): Promise<boolean> {
    const target = binding.target
    if (!torrentCurrent() || !message.messageId || options.allowsText?.(message.text, 'incoming') === false || !allowsFileNames(message) ||
      !await inbox.canReply(target, message.messageId) || await inbox.isRecalled(target, message.messageId)) return false
    const { botId, scene } = personMemoryAddress(target), excerpt = message.text || '[磁链下载]'
    const redactions = await personMemory.getRedactions({ identity: { botId, personaId: agentPersonaScopeId(binding.agentId) }, subjectId: message.sender.id })
    return !isPersonMemoryRedacted({ scene, messageId: message.messageId, authorId: message.sender.id, at: message.occurredAt, excerpt }, excerpt, redactions)
  }
  function torrentResponsible(source: IncomingMessage): boolean {
    if (!torrentCurrent() || source.conversation.kind !== 'group') return false
    try {
      const siblings = [...adapters.values()].filter(adapter => samePlatformNamespace(adapter.account, source.conversation.account))
      if (siblings.some(adapter => [adapter.account.id, adapter.botUserId].includes(source.sender.id))) return false
      const candidates = siblings.filter(adapter => adapter.isReady() && adapter.readMessage && adapter.actions.sendRequesterArchive &&
        conversationEnabled({ account: adapter.account, kind: 'group', id: source.conversation.id }) &&
        bindingFor({ account: adapter.account, kind: 'group', id: source.conversation.id }))
        .sort((a, b) => a.account.id < b.account.id ? -1 : a.account.id > b.account.id ? 1 : 0)
      const mentioned = candidates.filter(adapter => source.mentions.some(user => samePlatformNamespace(user, adapter.account) && user.id === adapter.botUserId))
      const pool = mentioned.length ? mentioned : candidates
      if (!pool.length) return false
      let hash = 2166136261
      const key = `${source.conversation.id}:${pool.map(adapter => adapter.account.id).join(',')}`
      for (let i = 0; i < key.length; i++) { hash ^= key.charCodeAt(i); hash = Math.imul(hash, 16777619) >>> 0 }
      return platformAccountKey(pool[hash % pool.length]!.account) === platformAccountKey(source.conversation.account)
    } catch { return false }
  }
  async function openTorrentContext(record: { readonly binding: AgentBindingSnapshot; readonly source: AgentTorrentSource;
    readonly trigger: AgentTorrentSource; readonly expiresAt: number }, externalSignal: AbortSignal): Promise<AgentTorrentWorkflowContext | 'wait' | undefined> {
    const binding = record.binding, target = binding.target, token = agentBindingToken(binding)
    if (!torrentCurrent() || target.kind !== 'group' || !conversationEnabled(target) || !bindingIsCurrent(target, token)) return undefined
    const adapter = adapterFor(target)
    if (!adapter?.readMessage || !adapter.actions.sendRequesterArchive) return undefined
    if (!adapter.isReady()) return 'wait'
    const memoryTurn = await beginMemoryTurn(binding), cancel = new AbortController()
    let signal: AbortSignal
    try { signal = AbortSignal.any([cancel.signal, memoryTurn.signal, toolCancellation.signal, externalSignal,
      AbortSignal.timeout(Math.max(1, Math.min(2_700_000, record.expiresAt - (options.now?.() ?? Date.now())))), ...(options.signal ? [options.signal] : [])]) }
    catch { memoryTurn.release(); return undefined }
    const pending = guardPendingSend(conversationAddressKey(target), () => !signal.aborted && torrentCurrent() &&
      adapter.isReady() && adapterFor(target) === adapter && conversationEnabled(target) && memoryTurn.isCurrent() && bindingIsCurrent(target, token))
    const isCurrent = () => !signal.aborted && pending.isCurrent(), observed = new Map<string, IncomingMessage>()
    const ensureCurrent = async () => {
      signal.throwIfAborted()
      if (!isCurrent()) throw new Error('磁链所属会话已失效')
      for (const message of observed.values()) if (!await torrentSourceAllowed(message, binding)) { cancel.abort(); throw new Error('磁链来源已失效') }
      signal.throwIfAborted()
      if (!isCurrent()) throw new Error('磁链所属会话已失效')
    }
    const timer = setInterval(() => { if (!isCurrent()) cancel.abort() }, 25); timer.unref()
    return { signal, isCurrent, ensureCurrent,
      async read(messageId, expected) {
        if (![record.source, record.trigger].some(item => item.messageId === messageId && item.occurredAt === expected.occurredAt &&
          platformAccountKey(item.sender) === platformAccountKey(expected.sender))) return undefined
        await ensureCurrent()
        const result = await adapter.readMessage!(target, messageId, { isCurrent })
        await ensureCurrent()
        if (!result || !sameTorrentSource(result, target, expected) || !await torrentSourceAllowed(result, binding) || !isCurrent()) return undefined
        observed.set(messageId, result)
        return result
      },
      release() { clearInterval(timer); cancel.abort(); pending.release(); memoryTurn.release() },
    }
  }
  async function handleTorrent(incoming: IncomingMessage, binding: AgentBindingSnapshot): Promise<boolean> {
    if (!torrent.isCandidate(incoming)) return false
    const age = (options.now?.() ?? Date.now()) - incoming.occurredAt
    if (age < -privacyCommandClockSkewMs || age >= textConversationSeconds * 1000) return true
    return await torrent.handle(incoming, binding)
  }

  function mediaRelayCurrent(): boolean {
    try { return mediaRelayConfig.enabled && options.mediaRelay?.enabled === true && options.isMediaRelayCurrent?.() !== false && isRunning() }
    catch { return false }
  }
  function mediaProviderEnabled(provider: AgentMediaShare['provider']): boolean {
    try { return (mediaRelayConfig.providers ?? ['bilibili']).includes(provider) &&
      (options.mediaRelay?.providers ?? ['bilibili']).includes(provider) }
    catch { return false }
  }
  function isMediaRelayCandidate(source: IncomingMessage): boolean {
    return mediaRelayCurrent() && source.conversation.kind === 'group' && !!source.messageId &&
      (source.parts.some(part => part.kind === 'extension' && (part.type === 'json' ||
        part.type === 'bilibili' && mediaProviderEnabled('bilibili') || part.type === 'douyin' && mediaProviderEnabled('douyin') ||
        part.type === 'xiaohongshu' && mediaProviderEnabled('xiaohongshu') || part.type === 'youtube' && mediaProviderEnabled('youtube') ||
        part.type === 'pixiv' && mediaProviderEnabled('pixiv'))) ||
        mediaProviderEnabled('bilibili') && /(?:b23\.tv|bilibili\.com)/iu.test(source.text) ||
        mediaProviderEnabled('douyin') && /(?:douyin\.com|iesdouyin\.com)/iu.test(source.text) ||
        mediaProviderEnabled('xiaohongshu') && /(?:xiaohongshu\.com|xhslink\.com)/iu.test(source.text) ||
        mediaProviderEnabled('youtube') && /(?:youtube\.com|youtu\.be)/iu.test(source.text) ||
        mediaProviderEnabled('pixiv') && /pixiv\.net/iu.test(source.text))
  }
  function mediaResponsible(source: IncomingMessage): boolean {
    if (source.conversation.kind !== 'group' || !mediaRelayCurrent()) return false
    try {
      const siblings = [...adapters.values()].filter(adapter => samePlatformNamespace(adapter.account, source.conversation.account))
      if (siblings.some(adapter => source.sender.id === adapter.account.id || source.sender.id === adapter.botUserId)) return false
      const candidates = siblings.filter(adapter => adapter.isReady() && adapter.readMediaShare && adapter.actions.sendMediaRelay &&
        bindingFor({ account: adapter.account, kind: 'group', id: source.conversation.id }))
        .sort((a, b) => a.account.id < b.account.id ? -1 : a.account.id > b.account.id ? 1 : 0)
      const mentioned = candidates.filter(adapter => source.mentions.some(user => samePlatformNamespace(user, adapter.account) && user.id === adapter.botUserId))
      const pool = mentioned.length ? mentioned : candidates
      if (!pool.length) return false
      let hash = 2166136261
      const key = `${source.conversation.id}:${pool.map(adapter => adapter.account.id).join(',')}`
      for (let i = 0; i < key.length; i++) { hash ^= key.charCodeAt(i); hash = Math.imul(hash, 16777619) >>> 0 }
      return platformAccountKey(pool[hash % pool.length]!.account) === platformAccountKey(source.conversation.account)
    } catch { return false }
  }
  async function openMediaRelayContext(record: Pick<AgentMediaOutboxRecord, 'binding' | 'expiresAt'> & {
    readonly source: Pick<AgentMediaOutboxRecord['source'], 'messageId' | 'sender' | 'occurredAt'> & { readonly share?: AgentMediaShare }
  }, externalSignal: AbortSignal): Promise<AgentMediaOutboxContext | 'wait' | undefined> {
    const binding = record.binding, target = binding.target, source = record.source
    if (!mediaRelayCurrent() || source.share && !mediaProviderEnabled(source.share.provider) || target.kind !== 'group' || !conversationEnabled(target) ||
        !bindingIsCurrent(target, agentBindingToken(binding))) return undefined
    const adapter = adapterFor(target)
    if (!adapter?.readMediaShare || !adapter.actions.sendMediaRelay) return undefined
    if (!adapter.isReady()) return 'wait'
    const memoryTurn = await beginMemoryTurn(binding), cancel = new AbortController()
    let signal: AbortSignal
    try { signal = AbortSignal.any([cancel.signal, memoryTurn.signal, toolCancellation.signal, externalSignal,
      AbortSignal.timeout(Math.max(1, Math.min(86_400_000, record.expiresAt - (options.now?.() ?? Date.now())))), ...(options.signal ? [options.signal] : [])]) }
    catch { memoryTurn.release(); return undefined }
    let observed: IncomingMessage | undefined
    const expected = agentBindingToken(binding)
    const pending = guardPendingSend(conversationAddressKey(target), () => !signal.aborted && mediaRelayCurrent() &&
      adapter.isReady() && adapterFor(target) === adapter && conversationEnabled(target) && memoryTurn.isCurrent() &&
      bindingIsCurrent(target, expected) && (!observed || mediaResponsible(observed)))
    const isCurrent = () => !signal.aborted && pending.isCurrent() && (!source.share || mediaProviderEnabled(source.share.provider))
    const { botId, scene } = personMemoryAddress(target), identity = { botId, personaId: agentPersonaScopeId(binding.agentId) }
    const allowsSource = async (message: IncomingMessage): Promise<boolean> => {
      if (!isCurrent() || message.messageId !== source.messageId || message.occurredAt !== source.occurredAt ||
          conversationAddressKey(message.conversation) !== conversationAddressKey(target) ||
          platformAccountKey(message.sender) !== platformAccountKey(source.sender) || !mediaResponsible(message) ||
          options.allowsText?.(message.text, 'incoming') === false || !allowsFileNames(message)) return false
      if (!await inbox.canReply(target, source.messageId) || await inbox.isRecalled(target, source.messageId) || !isCurrent()) return false
      const excerpt = message.text || '[媒体分享]'
      const redactions = await personMemory.getRedactions({ identity, subjectId: message.sender.id })
      if (isPersonMemoryRedacted({ scene, messageId: source.messageId, authorId: message.sender.id, at: source.occurredAt, excerpt }, excerpt, redactions) || !isCurrent()) return false
      observed = message
      return true
    }
    const ensureCurrent = async () => {
      signal.throwIfAborted()
      if (!isCurrent() || observed && !await allowsSource(observed)) throw new Error('媒体来源已失效')
      signal.throwIfAborted()
      if (!isCurrent()) throw new Error('媒体来源已失效')
    }
    const timer = setInterval(() => { if (!isCurrent()) cancel.abort() }, 25); timer.unref()
    return {
      signal, isCurrent, ensureCurrent,
      async readSource() {
        await ensureCurrent()
        const result = await adapter.readMediaShare!(target, source.messageId, { signal, isCurrent,
          expectedSource: { author: source.sender, occurredAt: source.occurredAt }, allowsSource })
        await ensureCurrent()
        if (!result || !mediaProviderEnabled(validateAgentMediaShare(result.share).provider) || !await allowsSource(result.message)) return undefined
        await ensureCurrent()
        return result
      },
      release() { clearInterval(timer); cancel.abort(); pending.release(); memoryTurn.release() },
    }
  }
  async function handleMediaRelay(incoming: IncomingMessage, binding: AgentBindingSnapshot): Promise<boolean> {
    if (!incoming.messageId || !isMediaRelayCandidate(incoming) || !mediaResponsible(incoming)) return false
    const now = options.now?.() ?? Date.now(), age = now - incoming.occurredAt
    if (age < -privacyCommandClockSkewMs || age >= textConversationSeconds * 1000) return true
    const context = await openMediaRelayContext({ binding, expiresAt: now + 86_400_000,
      source: { messageId: incoming.messageId, sender: incoming.sender, occurredAt: incoming.occurredAt } }, toolCancellation.signal)
    if (context === 'wait') throw new Error('媒体来源账号暂时断线')
    if (!context) return false
    try {
      const result = await context.readSource()
      if (!result) return false
      await context.ensureCurrent?.()
      const queued = await mediaOutbox.ledger.enqueue({ binding, source: { messageId: incoming.messageId,
        sender: incoming.sender, occurredAt: incoming.occurredAt, share: validateAgentMediaShare(result.share) } })
      if (queued === 'full') throw new Error('媒体队列已满')
      void mediaOutbox.tick().catch(error => diagnostics.emit({ stage: 'runtime', operation: 'media_outbox_tick', outcome: 'failed', error }))
      return true
    } finally { context.release() }
  }
  async function handleBilibiliQuality(incoming: IncomingMessage, binding: AgentBindingSnapshot): Promise<boolean> {
    if (!bilibiliQualityCurrent() || !bilibiliQuality || !isAgentBilibiliQualityCommand(incoming)) return false
    const target = binding.target, adapter = adapterFor(target), age = (options.now?.() ?? Date.now()) - incoming.occurredAt
    if (!adapter?.readMessage || !adapter.isReady() || !incoming.messageId || age < -privacyCommandClockSkewMs || age >= textConversationSeconds * 1000) return true
    const memory = await beginMemoryTurn(binding, false), cancel = new AbortController(), token = agentBindingToken(binding)
    const signal = AbortSignal.any([cancel.signal, memory.signal, toolCancellation.signal, AbortSignal.timeout(16 * 60_000), ...(options.signal ? [options.signal] : [])])
    const pending = guardPendingSend(conversationAddressKey(target), () => bilibiliQualityCurrent() && !signal.aborted && memory.isCurrent() &&
      adapterFor(target) === adapter && adapter.isReady() && conversationEnabled(target) && bindingIsCurrent(target, token), false)
    const current = () => !signal.aborted && pending.isCurrent()
    let released = false
    const release = () => { if (released) return; released = true; clearInterval(timer); cancel.abort(); pending.release(); memory.release() }
    const timer = setInterval(() => { if (!current()) release() }, 25); timer.unref()
    const { botId, scene } = personMemoryAddress(target), identity = { botId, personaId: agentPersonaScopeId(binding.agentId) }
    const readCurrent = async () => {
      if (!current() || !await inbox.canReply(target, incoming.messageId!) || await inbox.isRecalled(target, incoming.messageId!)) return undefined
      const observed = await adapter.readMessage!(target, incoming.messageId!, { isCurrent: current })
      const source = observed && mediaSafeMessage(observed)
      if (!source || source.messageId !== incoming.messageId || source.occurredAt !== incoming.occurredAt || platformAccountKey(source.sender) !== platformAccountKey(incoming.sender) ||
          conversationAddressKey(source.conversation) !== conversationAddressKey(target) || options.allowsText?.(source.text, 'incoming') === false || !current()) return undefined
      const redactions = await personMemory.getRedactions({ identity, subjectId: source.sender.id })
      if (!current() || isPersonMemoryRedacted({ scene, messageId: source.messageId!, authorId: source.sender.id, at: source.occurredAt, excerpt: source.text }, source.text, redactions)) return undefined
      return source
    }
    const ensureCurrent = async () => { signal.throwIfAborted(); if (!current() || !await readCurrent()) throw new Error('B站命令来源已失效'); signal.throwIfAborted() }
    try {
      const result = await diagnostics.run({ kind: 'conversation', binding, messageId: incoming.messageId }, 'bilibili_quality', () =>
        bilibiliQuality.handle(incoming, binding, { signal, isCurrent: current, ensureCurrent, readCurrent, release }), 'runtime')
      if (!result.consumed) release()
      return result.consumed
    } catch (error) { release(); diagnostics.emit({ stage: 'runtime', operation: 'bilibili_quality', outcome: 'failed', code: 'workflow_failed', error }); return true }
  }
  function magnetSearchCurrent(): boolean {
    try { return options.magnetSearch?.enabled === true && options.isMagnetSearchCurrent?.() !== false && isRunning() }
    catch { return false }
  }
  async function handleMagnetSearch(incoming: IncomingMessage, binding: AgentBindingSnapshot): Promise<boolean> {
    const command = parseAgentMagnetSearchCommand(incoming.text)
    if (!command || !magnetSearchCurrent()) return false
    const target = binding.target, adapter = adapterFor(target), token = agentBindingToken(binding), sourceId = incoming.messageId
    const age = (options.now?.() ?? Date.now()) - incoming.occurredAt
    if (!sourceId || !adapter?.readMessage || !adapter.isReady() || age >= textConversationSeconds * 1000 || age < -privacyCommandClockSkewMs) return true
    const memory = await beginMemoryTurn(binding, false), cancel = new AbortController()
    const signal = AbortSignal.any([cancel.signal, memory.signal, toolCancellation.signal, AbortSignal.timeout(65_000), ...(options.signal ? [options.signal] : [])])
    const pending = guardPendingSend(conversationAddressKey(target), () => !signal.aborted && magnetSearchCurrent() && memory.isCurrent() &&
      adapterFor(target) === adapter && adapter.isReady() && conversationEnabled(target) && bindingIsCurrent(target, token))
    const current = () => !signal.aborted && pending.isCurrent()
    const { botId, scene } = personMemoryAddress(target), identity = { botId, personaId: agentPersonaScopeId(binding.agentId) }
    const ensureCurrent = async () => {
      signal.throwIfAborted()
      if (!current() || !await inbox.canReply(target, sourceId) || await inbox.isRecalled(target, sourceId)) throw new Error('磁力命令来源已失效')
      const observed = await adapter.readMessage!(target, sourceId, { isCurrent: current })
      if (!observed || observed.messageId !== sourceId || observed.text !== incoming.text || observed.occurredAt !== incoming.occurredAt ||
          !isConversationAddress(observed.conversation) || conversationAddressKey(observed.conversation) !== conversationAddressKey(target) ||
          platformAccountKey(observed.sender) !== platformAccountKey(incoming.sender) || options.allowsText?.(observed.text, 'incoming') === false ||
          options.allowsToolInput?.(observed.text) === false || target.kind === 'private' && privatePeerFor(target, adapter) !== observed.sender.id || !current()) throw new Error('磁力命令来源已失效')
      const redactions = await personMemory.getRedactions({ identity, subjectId: incoming.sender.id })
      if (!current() || isPersonMemoryRedacted({ scene, messageId: sourceId, authorId: incoming.sender.id, at: incoming.occurredAt, excerpt: incoming.text }, incoming.text, redactions)) throw new Error('磁力命令来源已失效')
      signal.throwIfAborted()
    }
    const timer = setInterval(() => { if (!current()) cancel.abort() }, 25); timer.unref()
    try {
      await diagnostics.run({ kind: 'conversation', binding, messageId: sourceId }, 'magnet_search', async () => {
        await ensureCurrent()
        let text: string
        try { text = 'help' in command ? AGENT_MAGNET_SEARCH_HELP : await abortableAgentWeb(options.magnetSearchProvider!.search(command, { signal, isCurrent: current, ensureCurrent }), signal) }
        catch { await ensureCurrent(); text = '磁力搜索失败：公开索引暂不可用，请稍后重试。' }
        await ensureCurrent()
        if (typeof text !== 'string' || !text || text.length > 32768 || options.allowsToolInput?.(text) === false || options.allowsText?.(text, 'outgoing') === false) return
        await controlMessageActions.send({ version: 1, kind: 'message.send', target, binding, parts: [{ kind: 'text', text }], ...(target.kind === 'group' ? { replyTo: sourceId } : {}) }, { isCurrent: current })
      }, 'runtime')
    } catch (error) { diagnostics.emit({ stage: 'runtime', operation: 'magnet_search', outcome: 'cancelled', code: 'source_unavailable', error }) }
    finally { clearInterval(timer); cancel.abort(); pending.release(); memory.release() }
    return true
  }
  async function handleMusicExtraction(incoming: IncomingMessage, binding: AgentBindingSnapshot): Promise<boolean> {
    if (!extraction.isCandidate(incoming)) return false
    const target = binding.target, adapter = adapterFor(target), token = agentBindingToken(binding)
    const age = (options.now?.() ?? Date.now()) - incoming.occurredAt
    if (!adapter || !incoming.messageId || age >= textConversationSeconds * 1000 || age < -privacyCommandClockSkewMs) return true
    const memoryTurn = await beginMemoryTurn(binding)
    const cancel = new AbortController()
    const signal = AbortSignal.any([cancel.signal, memoryTurn.signal, toolCancellation.signal, AbortSignal.timeout(360_000),
      ...(options.signal ? [options.signal] : [])])
    const sendGuard = guardPendingSend(conversationAddressKey(target), () => !signal.aborted && isRunning() && memoryTurn.isCurrent() && options.isMusicExtractionCurrent?.() !== false &&
      adapter.isReady() && adapterFor(target) === adapter && conversationEnabled(target) && bindingIsCurrent(target, token))
    const isCurrent = () => !signal.aborted && sendGuard.isCurrent()
    const sources = new Map<string, IncomingMessage>()
    const { botId, scene } = personMemoryAddress(target)
    const identity = { botId, personaId: agentPersonaScopeId(binding.agentId) }
    const allowsSource = async (source: IncomingMessage): Promise<boolean> => {
      if (!isCurrent() || !isConversationAddress(source.conversation) || conversationAddressKey(source.conversation) !== conversationAddressKey(target) ||
          !source.messageId || !isMessageId(source.messageId) || !isPlatformAccount(source.sender) || !samePlatformNamespace(source.sender, target.account) ||
          !Number.isSafeInteger(source.occurredAt) || source.occurredAt <= 0 ||
          options.allowsText?.(source.text, 'incoming') === false || !allowsFileNames(source)) return false
      if (source.messageId === incoming.messageId && (platformAccountKey(source.sender) !== platformAccountKey(incoming.sender) ||
          source.occurredAt !== incoming.occurredAt)) return false
      if (!await inbox.canReply(target, incoming.messageId!) || await inbox.isRecalled(target, source.messageId) || !isCurrent()) return false
      const excerpt = source.text || '[音乐分享]'
      const redactions = await personMemory.getRedactions({ identity, subjectId: source.sender.id })
      if (isPersonMemoryRedacted({ scene, messageId: source.messageId, authorId: source.sender.id, at: source.occurredAt, excerpt }, excerpt, redactions) || !isCurrent()) return false
      sources.set(source.messageId, source)
      return true
    }
    const ensureCurrent = async () => {
      signal.throwIfAborted()
      if (!isCurrent()) throw new Error('音乐提取所属会话已失效')
      for (const source of sources.values()) if (!await allowsSource(source)) throw new Error('音乐提取来源已失效')
      signal.throwIfAborted()
      if (!isCurrent()) throw new Error('音乐提取所属会话已失效')
    }
    const timer = setInterval(() => { if (!isCurrent()) cancel.abort() }, 25)
    try { return await extraction.handle(incoming, binding, { signal, isCurrent, ensureCurrent, allowsSource }) }
    finally { clearInterval(timer); cancel.abort(); sendGuard.release(); memoryTurn.release() }
  }

  function groupLogForwardMessage(incoming: IncomingMessage, adapter: PlatformConnectionAdapter): IncomingMessage | undefined {
    const { binding: _binding, quote, ...message } = incoming
    if (textInboxFor(message.conversation)) {
      if (magnetSearchCurrent() && parseAgentMagnetSearchCommand(message.text)) return { ...message, ...quoteReference(quote) }
      const text = message.text.trim(), extractionCandidate = extraction.isCandidate(message), extractionCommand = extraction.isCommand(message)
      const mediaCandidate = isMediaRelayCandidate(message)
      if (!text && !extractionCandidate && !mediaCandidate || text.startsWith('#') ||
          text && '.\\/'.includes(text.charAt(0)) && !extractionCommand && !(magnetSearchCurrent() && parseAgentMagnetSearchCommand(message.text))) return undefined
      return { ...message, text, parts: message.parts.filter(part => part.kind === 'text' || part.kind === 'forward' || part.kind === 'file' ||
        (extractionCandidate || mediaCandidate) && part.kind === 'extension'), ...quoteReference(quote) }
    }
    return { ...message, parts: message.parts.map(part => part.kind === 'image' && adapter.readMessageImages ? { kind: 'image' as const } : part), ...quoteReference(quote) }
  }
  function releaseSilence(target: ConversationAddress, messageId: string): void {
    const key = conversationAddressKey(target), reservation = silenceReservations.get(key)
    reservation?.messages.delete(messageId)
    reservation?.admitting.delete(messageId)
    if (reservation && !reservation.messages.size) silenceReservations.delete(key)
  }

  async function consumeInbox(queue: AgentInboxQueue): Promise<void> {
    const accountKey = platformAccountKey(queue.account)
    const setPrivacyPending = queue.kind === 'privacy' ? (pending: boolean) => setPrivacyBacklog(accountKey, pending) : undefined
    while (isRunning()) {
      if (queue.kind === 'group-log' && privacyBlocked(accountKey)) return
      const item = await inbox.next(queue, setPrivacyPending)
      if (!item) {
        if (queue.kind === 'group-log') {
          for (const [key, reservation] of silenceReservations) if (platformAccountKey(reservation.target.account) === accountKey) {
            for (const id of reservation.messages) if (!reservation.admitting.has(id)) reservation.messages.delete(id)
            if (reservation.messages.size) continue
            silenceReservations.delete(key)
            const binding = bindingFor(reservation.target)?.binding
            if (binding) await groupLogWorkflow.restore(reservation.target, binding)
            else setConversationAI(reservation.target, true)
          }
        }
        return
      }
      if (!isRunning()) return
      const { event: originalEvent, bindingToken } = item.entry ?? {}
      // Older inboxes retain their exact ACK bytes, but access queries cannot flow
      // from a recovered entry into a new model/history record.
      let event = originalEvent
      const target = inboxEventTarget(event)
      const adapter = isConversationAddress(target) && platformAccountKey(target.account) === accountKey ? adapterFor(target) : undefined
      if (event && target && adapter && hasValidInboundEvent(event, adapter) &&
        (event.kind !== 'message' || options.allowsText?.(event.message.text, 'incoming') !== false && allowsFileNames(event.message))) {
        if (event.kind === 'message') event = { ...event, message: mediaSafeMessage(event.message) }
        const request = event.kind === 'message' ? personMemoryCommand(event.message) : undefined
        if (queue.kind === 'privacy') {
          if (event.kind === 'message' && request?.standalone && 'privacyCommand' in item.entry && request.command === item.entry.privacyCommand &&
              !await applyPrivacyCommand(event.message, request.command, bindingToken, item.raw, adapter,
                'privacyOwner' in item.entry ? item.entry.privacyOwner : undefined)) return
        } else if (queue.kind === 'group-log') {
          const capture = 'groupLog' in item.entry ? item.entry.groupLog : undefined
          const selected = target.kind === 'group' ? bindingFor(target) : undefined
          const diceSource = event.kind === 'message' && (diceRevocationCandidate(event.message) || !!capture && 'dicePolicy' in capture ||
            !!event.message.messageId && await diceState.hasSourceByTarget(target, event.message.messageId))
          const diceAdmitted = !!capture && 'dicePolicy' in capture && capture.dicePolicy === dicePolicy
          const diceRevoked = diceSource && (!diceCurrent() || !diceAdmitted || !selected || capture?.agentId !== selected.binding.agentId ||
            bindingToken !== agentBindingToken(selected.binding))
          if (diceRevoked && event.kind === 'message' && event.message.messageId) await revokeDiceSource(target, event.message.messageId)
          if (event.kind === 'message' && event.message.messageId && capture && selected && capture.agentId === selected.binding.agentId &&
              bindingToken === agentBindingToken(selected.binding)) {
            if (!adapter.isReady()) return
            const incoming = event.message
            const outcome = groupLogEnabled ? await diagnostics.run({ kind: 'conversation', binding: selected.binding, messageId: incoming.messageId! }, 'group_log',
              () => groupLogWorkflow.handle(incoming, selected.binding, capture), 'runtime') : { consumed: false, aiAllowed: allowsConversationAI(target) }
            const gameHandled = !outcome.consumed && await handleGames(incoming, selected.binding)
            const diceHandled = gameHandled || diceRevoked || await handleDice(incoming, selected.binding, capture)
            releaseSilence(target, event.message.messageId)
            if (groupLogEnabled) await groupLogWorkflow.restore(target, selected.binding)
            const qualityHandled = !diceHandled && bilibiliQualityCurrent() && isAgentBilibiliQualityCommand(incoming)
              ? await handleBilibiliQuality(incoming, selected.binding) : false
            // Recording silence consumes ordinary AI messages as well as log
            // commands. Explicit searches retain their independent command path.
            const magnetHandled = !diceHandled && !qualityHandled && !parseAgentGroupLogCommand(incoming.text) && conversationEnabled(target) &&
              await handleMagnetSearch(incoming, selected.binding)
            if (!outcome.consumed && !diceHandled && !qualityHandled && !magnetHandled && outcome.aiAllowed && conversationEnabled(target)) {
              const message = groupLogForwardMessage(event.message, adapter)
              if (message) {
                const destination: AgentInboxQueue = { account: queue.account, kind: textInboxFor(target)?.kind ?? 'simulation' }
                await inbox.forward(item.raw, queue, destination, { ...item.entry, event: { kind: 'message', message },
                  bindingToken: destination.kind === 'simulation' ? agentBindingToken(selected.binding) : textBindingToken(selected.binding) })
                if (activityHydrated) kickInbox(destination)
                continue
              }
            }
          }
        } else if (event.kind === 'recall') {
          if (queue.kind === 'simulation' && target.kind !== 'private' && await inbox.isRecalled(target, event.messageId)) {
            await runtime.handleRecall({ message_id: event.messageId }, target)
          }
        } else if (!request) {
          const expectedQueue = textInboxFor(target)?.kind ?? 'simulation'
          const selectedPersona = conversationEnabled(target) && expectedQueue === queue.kind ? bindingFor(target) : undefined
          const gameMessage = event.kind === 'message' ? event.message : undefined
          const gameCandidate = selectedPersona && gameMessage && gameHandlers.some(handler => handler.isCandidate(gameMessage, selectedPersona.binding))
          const persona = selectedPersona && (allowsConversationAI(target) || gameCandidate) ? selectedPersona : undefined
          if (persona && (queue.kind === 'simulation' ? agentBindingToken(persona.binding) : textBindingToken(persona.binding)) === bindingToken &&
              (event.kind !== 'message' || !event.message.binding || isSameBinding(event.message.binding, persona.binding))) {
            if (event.kind === 'message' && (extraction.isCandidate(event.message) || isMediaRelayCandidate(event.message) || torrent.isCandidate(event.message) || magnetSearchCurrent() && parseAgentMagnetSearchCommand(event.message.text)) && !adapter.isReady()) return
            const gameHandled = event.kind === 'message' && await handleGames(event.message, persona.binding)
            const qualityHandled = !gameHandled && event.kind === 'message' && await handleBilibiliQuality(event.message, persona.binding)
            const magnetHandled = !gameHandled && !qualityHandled && event.kind === 'message' && await handleMagnetSearch(event.message, persona.binding)
            const torrentHandled = !gameHandled && !qualityHandled && !magnetHandled && event.kind === 'message' && await handleTorrent(event.message, persona.binding)
            const mediaHandled = !gameHandled && !qualityHandled && !magnetHandled && !torrentHandled && event.kind === 'message' && await handleMediaRelay(event.message, persona.binding)
            const musicHandled = !gameHandled && !qualityHandled && !magnetHandled && !torrentHandled && !mediaHandled && event.kind === 'message' && await handleMusicExtraction(event.message, persona.binding)
            if (gameHandled || qualityHandled || magnetHandled || torrentHandled || mediaHandled || musicHandled) {
              // Deterministic relay commands and accepted shares never become model prompts.
            } else if (queue.kind !== 'simulation' && event.kind === 'message') {
              if (!adapter.isReady()) return
              const expected = agentBindingToken(persona.binding)
              const incoming = event.message
              const memoryTurn = await beginMemoryTurn(persona.binding)
              const isCurrent = () => observeCurrent(() => isRunning() && conversationEnabled(target) && textInboxFor(target)?.kind === queue.kind &&
                memoryTurn.isCurrent() && bindingIsCurrent(target, expected))
              let handedToTrigger = false
              try {
                if (options.allowsText?.(incoming.text, 'incoming') !== false) {
                  await conversationMemory.capture(incoming, persona.binding, isCurrent)
                  await semanticMemory.capture(incoming, persona.binding, isCurrent)
                  await captureCognition(incoming, persona.binding, isCurrent).catch(error => diagnostics.emit({ stage: 'memory', operation: 'cognition_capture', outcome: 'failed', error }))
                  await history.capture(incoming, persona.binding, isCurrent)
                  await groupMemory.capture(incoming, persona.binding, isCurrent)
                  if (target.kind === 'group' && incoming.messageId && options.textTrigger !== undefined) {
                    const recallVersion = await inbox.textRecallVersion(target)
                    const current = () => observeCurrent(() => isCurrent() && options.isTextTriggerCurrent?.() !== false && adapterFor(target) === adapter && adapter.isReady())
                    const sourceCurrent = async () => {
                      if (!current() || !await inbox.canReply(target, incoming.messageId!) || await inbox.textRecallVersion(target) !== recallVersion) return false
                      const { botId, scene } = personMemoryAddress(target), excerpt = incoming.text || '[群聊消息]'
                      const redactions = await personMemory.getRedactions({ identity: { botId, personaId: agentPersonaScopeId(persona.binding.agentId) }, subjectId: incoming.sender.id })
                      if (!current() || isPersonMemoryRedacted({ scene, messageId: incoming.messageId!, authorId: incoming.sender.id,
                        at: incoming.occurredAt, excerpt }, excerpt, redactions)) return false
                      const unchanged = await inbox.textRecallVersion(target) === recallVersion
                      return current() && unchanged
                    }
                    const ensureCurrent = async () => {
                      if (!await sourceCurrent()) throw new Error('文字触发来源已失效')
                    }
                    // Known revocation consumes this entry. Storage failures still
                    // escape to the inbox retry path before any external work.
                    if (await sourceCurrent()) {
                      handedToTrigger = true
                      textTrigger.admit({ incoming, selected: persona, isCurrent: current, ensureCurrent, signal: memoryTurn.signal, release: memoryTurn.release })
                    }
                  } else await diagnostics.run({ kind: 'conversation', binding: persona.binding, ...(incoming.messageId ? { messageId: incoming.messageId } : {}) }, 'text_turn',
                    () => textConversation.reply(incoming, persona, isCurrent, memoryTurn.signal), 'inbox')
                }
              } finally {
                if (!handedToTrigger) memoryTurn.release()
              }
            } else if (queue.kind === 'simulation' && event.kind === 'nudge' &&
                'ingressId' in item.entry && isMessageId(item.entry.ingressId)) {
              await runtime.ingestNudge(event, { isCurrent: isRunning, binding: persona.binding, ingressId: item.entry.ingressId })
            } else if (event.kind === 'message' && event.message.messageId && options.allowsText?.(event.message.text, 'incoming') !== false &&
                !await inbox.isRecalled(target, event.message.messageId) && isRunning()) {
              const { quote, ...incoming } = event.message
              await conversationMemory.capture(incoming, persona.binding, () => isRunning() && bindingIsCurrent(target, agentBindingToken(persona.binding)))
              await semanticMemory.capture(incoming, persona.binding, () => isRunning() && bindingIsCurrent(target, agentBindingToken(persona.binding)))
              await captureCognition(incoming, persona.binding, () => isRunning() && bindingIsCurrent(target, agentBindingToken(persona.binding))).catch(error => diagnostics.emit({ stage: 'memory', operation: 'cognition_capture', outcome: 'failed', error }))
              await history.capture(incoming, persona.binding, () => isRunning() && bindingIsCurrent(target, agentBindingToken(persona.binding)))
              await groupMemory.capture(incoming, persona.binding, () => isRunning() && bindingIsCurrent(target, agentBindingToken(persona.binding)))
              await diagnostics.run({ kind: 'conversation', binding: persona.binding, ...(incoming.messageId ? { messageId: incoming.messageId } : {}) }, 'simulation_ingest',
                () => runtime.ingest({ ...incoming, ...quoteReference(quote), binding: persona.binding }, { isCurrent: isRunning }), 'inbox')
            }
          }
        }
      }
      if (!isRunning()) return
      await inbox.acknowledge(item.raw, queue, setPrivacyPending)
      if (queue.kind === 'private' || queue.kind === 'group') void textPersonMemory.tick()
      void conversationMemory.tick()
      void semanticMemory.tick()
      void history.tick()
      void groupMemory.tick()
    }
  }

  function kickInbox(queue: AgentInboxQueue): Promise<void> | undefined {
    const key = JSON.stringify([queue.kind, platformAccountKey(queue.account)])
    if (!isRunning() || retryTimers.has(key)) return undefined
    const current = consumers.get(key)
    if (current) return current
    const consumer = consumeInbox(queue).catch(error => {
      void diagnostics.run({ kind: 'account', account: queue.account }, `consume_${queue.kind}`, async () => {
        diagnostics.emit({ stage: 'inbox', operation: `consume_${queue.kind}`, outcome: 'failed', code: 'inbox_retry_pending', error })
      }, 'inbox')
      logger.warn('[Agent] 收件处理失败，保留队列并等待重试')
      if (isRunning()) retryTimers.set(key, setTimeout(() => { retryTimers.delete(key); kickInbox(queue) }, 1_000))
    }).finally(() => { consumers.delete(key) })
    consumers.set(key, consumer)
    return consumer
  }

  function kickInboxes(): Promise<void>[] {
    const recovery: Promise<void>[] = []
    for (const {account} of adapters.values()) {
      const privacy = kickInbox({ account, kind: 'privacy' })
      kickInbox({ account, kind: 'group-log' })
      const simulation = kickInbox({ account, kind: 'simulation' })
      if (privacy) recovery.push(privacy)
      if (simulation) recovery.push(simulation)
      if (options.privateChatEnabled) kickInbox({ account, kind: 'private' })
      kickInbox({ account, kind: 'group' })
    }
    return recovery
  }

  const commitmentTasks = new Map<string, Promise<void>>()
  function tickCommitments(): void {
    if (!isRunning()) return
    for (const adapter of adapters.values()) {
      if (!adapter.isReady()) continue
      const key = platformAccountKey(adapter.account)
      if (commitmentTasks.has(key)) continue
      const operation = Promise.resolve().then(async () => {
        await commitments.commitmentTick(adapter.account)
        if (isRunning()) await deferredActions.tick(adapter.account)
      }).catch(error => { void diagnostics.run({ kind: 'account', account: adapter.account }, 'commitment_tick', async () => { diagnostics.emit({ stage: 'runtime', operation: 'commitment_tick', outcome: 'failed', code: 'commitment_retry_pending', error }) }) })
        .finally(() => { if (commitmentTasks.get(key) === operation) commitmentTasks.delete(key) })
      commitmentTasks.set(key, operation)
    }
  }

  async function runMaintenance(operation: string, task: () => Promise<unknown>): Promise<void> {
    try { await task() }
    catch (error) { diagnostics.emit({ stage: 'runtime', operation, outcome: 'failed', error }) }
  }

  async function start(): Promise<void> {
    if (started || stopping) return
    started = true
    try {
      options.signal?.throwIfAborted()
      await inbox.moveLegacySimulationQueue(isRunning)
      if (!isRunning()) { await stop(); return }
      const pending = await inbox.accountsWithPrivacyWork(options.adapters.map(adapter => adapter.account))
      for (const account of pending) setPrivacyBacklog(platformAccountKey(account), true)
      if (groupLogEnabled) {
        const accounts = options.adapters.map(adapter => adapter.account)
        await groupLogs.recover(accounts)
        for (const owner of await groupLogs.listOwners(accounts)) {
          const current = bindingFor(owner.target)?.binding
          if (current?.agentId === owner.agentId) await groupLogWorkflow.restore(owner.target, current)
        }
      }
      if (!isRunning()) { await stop(); return }
      await bilibiliQuality?.start()
      await runtime.start()
      if (!isRunning()) { runtime.stop(); await stop(); return }
      await Promise.all([...adapters.values()].map(adapter => adapter.start(event => accept(adapter, event))))
      options.signal?.throwIfAborted()
      if (!isRunning()) return
      if (groupLogEnabled) {
        // Restore pending controls before enabling AI or resuming automatic outboxes.
        await Promise.all(options.adapters.map(adapter => kickInbox({ account: adapter.account, kind: 'privacy' })))
        for (const adapter of options.adapters) if (privacyBlocked(platformAccountKey(adapter.account))) throw new Error('隐私删除恢复尚未完成，AI保持静默')
        await Promise.all(options.adapters.map(adapter => kickInbox({ account: adapter.account, kind: 'group-log' })))
        for (const adapter of options.adapters) if (await inbox.next({ account: adapter.account, kind: 'group-log' })) throw new Error('团录恢复尚未完成，AI保持静默')
        for (const owner of await groupLogs.listOwners(options.adapters.map(adapter => adapter.account))) {
          const current = bindingFor(owner.target)?.binding
          if (current?.agentId === owner.agentId) await groupLogWorkflow.restore(owner.target, current)
        }
      }
      activityHydrated = true
      if (mediaRelayConfig.enabled) await mediaOutbox.start()
      if (torrentConfig.enabled) await torrent.start()
      const recovered = kickInboxes()
      maintenance = setInterval(() => {
        kickInboxes()
        tickCommitments()
        if (mediaRelayConfig.enabled) void runMaintenance('media_outbox_tick', () => mediaOutbox.tick())
        if (torrentConfig.enabled) void runMaintenance('torrent_tick', () => torrent.tick())
        void runMaintenance('person_memory_tick', () => textPersonMemory.tick())
        void runMaintenance('conversation_memory_tick', () => conversationMemory.tick())
        void runMaintenance('semantic_memory_tick', () => semanticMemory.tick())
        void runMaintenance('history_tick', () => history.tick())
        void runMaintenance('group_memory_tick', () => groupMemory.tick())
      }, 1_000)
      maintenance.unref()
      await Promise.all(recovered)
      if (!isRunning()) return
      await runtime.sweepOnce()
      await textPersonMemory.tick()
      await conversationMemory.tick()
      await semanticMemory.tick()
      await history.tick()
      await groupMemory.tick()
      if (isRunning()) tickCommitments()
    } catch (error) {
      await stop()
      throw error
    }
  }

  function stop(): Promise<void> {
    if (shuttingDown) return shuttingDown
    stopping = true
    const textDrained = textTrigger.stop()
    const deferredDrained = deferredActions.drain()
    activity.close()
    for (const state of activityStates.values()) groupLogWorkflow.invalidate(state.target)
    toolCancellation.abort()
    if (maintenance) clearInterval(maintenance)
    for (const retryTimer of retryTimers.values()) clearTimeout(retryTimer)
    for (const waiter of privacyWaiters.values()) waiter.resolve()
    privacyWaiters.clear()
    for (const adapter of adapters.values()) adapter.stop()
    runtime.stop()
    shuttingDown = Promise.allSettled([textDrained, deferredDrained, localEmojiIngress?.stop(), ...commitmentTasks.values(), ...pendingAdmissions, ...automaticQqWork.values(), ...gameHandlers.map(handler => Promise.resolve().then(() => handler.stop())), ...consumers.values(), ...(bilibiliQuality ? [bilibiliQuality.stop()] : []), torrent.stop(), mediaOutbox.stop(), commitments.drainCommitmentTicks(), runtime.drain(), textPersonMemory.stop(), conversationMemory.stop(), semanticMemory.stop(), history.stop(), groupMemory.stop()]).then(async results => {
      for (const result of results) if (result.status === 'rejected') diagnostics.emit({ stage: 'runtime', operation: 'shutdown', outcome: 'failed', error: result.reason })
      await diagnostics.flush()
    })
    return shuttingDown
  }

  options.signal?.addEventListener('abort', () => { void stop() }, { once: true })

  return {
    runtime,
    management,
    /** Trusted host cleanup only; never installed as a model tool. */
    semanticMemoryCleanup,
    conversationMemoryCleanup,
    sourceMemoryCleanup,
    groupMemoryCleanup,
    /** Expected admission identity for read-only queue observations; does not claim or execute work. */
    inboxBindingToken(binding: AgentBindingSnapshot, queue: AgentInboxQueue['kind']): string {
      return queue === 'private' || queue === 'group' ? textBindingToken(binding) : agentBindingToken(binding)
    },
    start,
    stop,
    async resumePendingWork() {
      if (started && !stopping) {
        kickInboxes()
        if (torrentConfig.enabled) await torrent.tick()
        tickCommitments()
        await runtime.sweepOnce()
        await textPersonMemory.tick()
        await conversationMemory.tick()
        await groupMemory.tick()
      }
    },
  }
}
